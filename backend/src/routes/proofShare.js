const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Proof = require('../models/Proof');
const { validShare } = require('../utils/proofShare');

const router = express.Router();

// A short-lived, signed link lets a customer view the current artwork without
// an ERP login. A new version invalidates the earlier version's links.
router.get('/:proofId/:fileId/:expires/:signature', async (req, res) => {
  const { proofId, fileId, expires, signature } = req.params;
  if (!mongoose.isValidObjectId(proofId) || !mongoose.isValidObjectId(fileId)) return res.sendStatus(404);
  try {
    const proof = await Proof.findById(proofId).select('version files');
    if (!proof || !validShare(proof, fileId, expires, signature)) return res.sendStatus(404);
    const file = proof.files.find((item) => String(item.fileId) === fileId);
    if (!file?.fileUrl?.startsWith('/uploads/files/')) return res.sendStatus(404);
    const filePath = path.join(process.cwd(), 'uploads/files', path.basename(file.fileUrl));
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`);
    res.type(file.mimeType || 'application/octet-stream');
    return res.sendFile(filePath);
  } catch (error) {
    console.error('Proof share failed:', error);
    return res.sendStatus(404);
  }
});

module.exports = router;
