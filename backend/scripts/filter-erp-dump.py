#!/usr/bin/env python3
"""Extract Carbon ERP documents from a mixed mongodump directory.

Requires the MongoDB Database Tools (`bsondump`). Original BSON document bytes
are copied unchanged. No database connection or writes to the source are made.
"""

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
from pathlib import Path


ERP_COLLECTIONS = {
    "accessroles", "accountbalances", "accounttransactions", "activitylogs",
    "attendances", "bankreconciliations", "categories", "cheques", "costs",
    "customerfiles", "customerpricings", "customers", "deliveries",
    "discountrules", "emergencyorders", "employees", "events", "files",
    "hsncodes", "inventories", "inventorymovements", "invoices", "jobs",
    "leaverequests", "notifications", "numbersequences", "paymentreminders",
    "payments", "payrolls", "portalaccesses", "portalsessions", "proofs",
    "purchasebills", "purchaseorders", "quotations", "saccodes", "schedules",
    "settings", "tasks", "teams", "timeentries", "units", "users", "vendors",
    "walkinjobs",
}

ERP_ROLES = {"admin", "manager", "operator", "designer", "accountant", "staff"}
USER_INDEXES = {
    "_id_", "email_1", "status_1", "dataScope_1",
    "invitation.tokenHash_1", "invitation.usedTokenHash_1",
}


def oid(value):
    return value.get("$oid") if isinstance(value, dict) else value


def documents(source):
    """Return raw BSON frames and corresponding Extended JSON records."""
    result = subprocess.run(
        ["bsondump", "--quiet", "--type=json", str(source)],
        check=True, capture_output=True, text=True,
    )
    parsed = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    data = source.read_bytes()
    frames = []
    pos = 0
    while pos < len(data):
        if pos + 4 > len(data):
            raise ValueError(f"Truncated BSON length in {source}")
        length = struct.unpack_from("<i", data, pos)[0]
        if length < 5 or pos + length > len(data) or data[pos + length - 1] != 0:
            raise ValueError(f"Invalid BSON frame in {source} at {pos}")
        frames.append(data[pos:pos + length])
        pos += length
    if len(frames) != len(parsed):
        raise ValueError(f"BSON/JSON count mismatch in {source}")
    return list(zip(parsed, frames))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Source mongodump database directory")
    parser.add_argument("destination", type=Path, help="New, empty output directory")
    args = parser.parse_args()
    source, destination = args.source.resolve(), args.destination.resolve()
    if not source.is_dir() or destination.exists() or destination == source:
        parser.error("Source must exist and destination must be a new directory")

    user_docs = documents(source / "users.bson")
    erp_users = [doc for doc, _ in user_docs if doc.get("dataScope") and doc.get("role") in ERP_ROLES]
    scopes = {doc["dataScope"] for doc in erp_users}
    user_ids = {oid(doc["_id"]) for doc in erp_users}
    if not scopes or not user_ids:
        raise ValueError("No ERP users with dataScope found; refusing to export")

    db_dir = destination / "carbon_erp"
    db_dir.mkdir(parents=True)
    counts = {}
    for name in sorted(ERP_COLLECTIONS):
        bson_path = source / f"{name}.bson"
        if not bson_path.exists():
            raise FileNotFoundError(bson_path)
        pairs = user_docs if name == "users" else documents(bson_path)
        kept = []
        for doc, frame in pairs:
            if name == "users":
                keep = oid(doc["_id"]) in user_ids
            elif name == "numbersequences":
                key = str(doc.get("_id", ""))
                keep = (key.startswith("account-transaction:") or
                        any(key.startswith(f"{prefix}:{scope}:") for scope in scopes
                            for prefix in ("invoice", "purchase-bill")))
            else:
                keep = (doc.get("dataScope") in scopes or
                        (doc.get("dataScope") is None and oid(doc.get("userId")) in user_ids))
            if keep:
                kept.append(frame)
        counts[name] = {"source": len(pairs), "included": len(kept), "excluded": len(pairs) - len(kept)}
        # A collection with only foreign records may carry foreign indexes too.
        # Let Mongoose create the ERP collection when the app first uses it.
        if pairs and not kept:
            continue
        (db_dir / f"{name}.bson").write_bytes(b"".join(kept))

        metadata_path = source / f"{name}.metadata.json"
        if metadata_path.exists():
            metadata = json.loads(metadata_path.read_text())
            metadata.pop("uuid", None)
            if name == "users":
                metadata["indexes"] = [index for index in metadata.get("indexes", [])
                                       if index.get("name") in USER_INDEXES]
            (db_dir / metadata_path.name).write_text(json.dumps(metadata, indent=2) + "\n")

    report = {
        "purpose": "Carbon ERP records only, from a mixed MongoDB dump",
        "source_directory": str(source),
        "erp_data_scopes": sorted(scopes),
        "erp_user_count": len(user_ids),
        "collections": counts,
        "excluded_entirely": sorted(p.stem for p in source.glob("*.bson") if p.stem not in ERP_COLLECTIONS),
        "notes": [
            "ERP users are identified by dataScope and ERP role; other records match dataScope or an ERP userId.",
            "OTP records are omitted because they are temporary authentication codes.",
            "Original BSON documents are copied byte for byte; source files are not changed.",
            "The source admin database's system users and roles are not exported.",
            "The mixed users collection's unrelated indexes are removed from its metadata.",
        ],
    }
    (destination / "export-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (destination / "RESTORE.txt").write_text(
        "Carbon ERP-only mongodump. Restore into a NEW database, after reviewing export-report.json.\n"
        "Example: mongorestore --db carbon_erp /path/to/extracted/carbon_erp\n"
        "Configure the ERP's MONGODB_URI to use that database only after validation.\n"
    )
    archive = shutil.make_archive(str(destination), "zip", root_dir=destination)
    digest = hashlib.sha256(Path(archive).read_bytes()).hexdigest()
    print(json.dumps({"archive": archive, "sha256": digest,
                      "included_records": sum(v["included"] for v in counts.values()),
                      "excluded_records_in_erp_collections": sum(v["excluded"] for v in counts.values())}, indent=2))


if __name__ == "__main__":
    main()
