/**
 * Bulk-create WhatsApp message templates via the Meta Graph API
 *
 * Reads wabaId / accessToken from the Settings document of a user, then submits
 * every template in TEMPLATES below for approval. Templates that already exist
 * on the WABA are skipped, so the script is safe to re-run.
 *
 * Usage:
 *   node backend/scripts/createWhatsAppTemplates.js <user-email>
 *   node backend/scripts/createWhatsAppTemplates.js <user-email> --dry-run
 *   node backend/scripts/createWhatsAppTemplates.js <user-email> --only=payment_reminder,invoice_created
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/print_arts_flow';
const GRAPH_VERSION = 'v19.0';

const LANGUAGE = 'en_US';
const OPT_OUT_FOOTER = 'Reply STOP to opt out of these updates.';

/**
 * Meta rules baked into these bodies:
 *  - variables are numbered {{1}}..{{n}}, sequential, no gaps
 *  - the body never starts or ends with a variable
 *  - no two variables sit next to each other
 *  - every variable has a sample value (Meta rejects the template otherwise)
 *  - footers cannot contain variables
 */
const TEMPLATES = [
  {
    name: 'payment_reminder',
    category: 'UTILITY',
    body:
      'Hi {{1}}, this is a friendly reminder that your invoice {{2}} of Rs. {{3}} has a pending balance of Rs. {{4}}. The payment was due on {{5}}. Please make the payment at your earliest convenience.\n\nThank you,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '45,000', '15,000', '05 Aug 2026', 'Serpy Industries'],
    footer: OPT_OUT_FOOTER,
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'totalAmount', 4: 'balanceAmount', 5: 'dueDate', 6: 'businessName' }
  },
  {
    name: 'payment_overdue_notice',
    category: 'UTILITY',
    body:
      'Hi {{1}}, our records show that invoice {{2}} with an outstanding balance of Rs. {{3}} is now {{4}} days past its due date of {{5}}. Kindly arrange the payment, or reply to this message if you need any help with it.\n\nThank you,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '15,000', '12', '05 Aug 2026', 'Serpy Industries'],
    footer: OPT_OUT_FOOTER,
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'balanceAmount', 4: 'daysOverdue', 5: 'dueDate', 6: 'businessName' }
  },
  {
    name: 'payment_due_soon',
    category: 'UTILITY',
    body:
      'Hi {{1}}, a quick heads-up that invoice {{2}} for Rs. {{3}} is due on {{4}}. Please ignore this message if the payment is already on its way.\n\nThank you,\n{{5}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '45,000', '05 Aug 2026', 'Serpy Industries'],
    footer: OPT_OUT_FOOTER,
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'balanceAmount', 4: 'dueDate', 5: 'businessName' }
  },
  {
    name: 'invoice_created',
    category: 'UTILITY',
    body:
      'Hi {{1}}, your invoice {{2}} dated {{3}} for Rs. {{4}} has been generated. The payment is due on {{5}}. Reply to this message if you need a copy of the invoice or have any questions.\n\nThank you,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'INV-2026-0142', '01 Aug 2026', '45,000', '05 Aug 2026', 'Serpy Industries'],
    mapping: { 1: 'customerName', 2: 'invoiceNumber', 3: 'invoiceDate', 4: 'totalAmount', 5: 'dueDate', 6: 'businessName' }
  },
  {
    name: 'payment_received',
    category: 'UTILITY',
    body:
      'Hi {{1}}, we have received your payment of Rs. {{2}} towards invoice {{3}} on {{4}}. Your remaining balance is Rs. {{5}}. Thank you for your business.\n\nRegards,\n{{6}} Team',
    samples: ['Rajesh Kumar', '30,000', 'INV-2026-0142', '08 Aug 2026', '15,000', 'Serpy Industries'],
    mapping: { 1: 'customerName', 2: 'amountPaid', 3: 'invoiceNumber', 4: 'paymentDate', 5: 'balanceAmount', 6: 'businessName' }
  },
  {
    name: 'quotation_shared',
    category: 'UTILITY',
    body:
      'Hi {{1}}, thank you for your enquiry. Quotation {{2}} dated {{3}} for Rs. {{4}} is ready for your review and is valid until {{5}}. Reply to this message to confirm the order or to request any changes.\n\nRegards,\n{{6}} Team',
    samples: ['Rajesh Kumar', 'QTN-2026-0087', '01 Aug 2026', '45,000', '15 Aug 2026', 'Serpy Industries'],
    mapping: { 1: 'customerName', 2: 'quotationNumber', 3: 'quotationDate', 4: 'totalAmount', 5: 'validUntil', 6: 'businessName' }
  }
];

function buildComponents(template) {
  const varCount = new Set(template.body.match(/\{\{(\d+)\}\}/g) || []).size;
  if (varCount !== template.samples.length) {
    throw new Error(
      `${template.name}: body has ${varCount} variables but ${template.samples.length} samples were supplied`
    );
  }

  const components = [
    {
      type: 'BODY',
      text: template.body,
      ...(varCount > 0 ? { example: { body_text: [template.samples] } } : {})
    }
  ];

  if (template.footer) {
    components.push({ type: 'FOOTER', text: template.footer });
  }

  return components;
}

async function fetchExistingNames(wabaId, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates?fields=name,status&limit=200`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.error_user_msg || data.error?.message || 'Failed to list existing templates');
  }

  return new Map((data.data || []).map((t) => [t.name, t.status]));
}

async function createTemplate(wabaId, accessToken, template) {
  const payload = {
    name: template.name,
    language: LANGUAGE,
    category: template.category,
    components: buildComponents(template)
  };

  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.error_user_msg || data.error?.message || 'Unknown Meta API error');
  }

  return data;
}

async function run() {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.replace('--only=', '').split(',').map((s) => s.trim()) : null;

  if (!email) {
    console.error('Usage: node backend/scripts/createWhatsAppTemplates.js <user-email> [--dry-run] [--only=name1,name2]');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new Error(`No user found with email ${email}`);

  const settings = await Settings.findOne({ userId: user._id });
  const { wabaId, accessToken } = settings?.whatsappIntegration || {};
  if (!wabaId || !accessToken) {
    throw new Error(`WhatsApp credentials are not configured for ${email}`);
  }

  const selected = only ? TEMPLATES.filter((t) => only.includes(t.name)) : TEMPLATES;
  if (selected.length === 0) throw new Error('No templates matched --only');

  console.log(`\nWABA ${wabaId} — submitting ${selected.length} template(s)${dryRun ? ' (dry run)' : ''}\n`);

  const existing = await fetchExistingNames(wabaId, accessToken);

  for (const template of selected) {
    if (existing.has(template.name)) {
      console.log(`⏭️  ${template.name} — already exists (${existing.get(template.name)})`);
      continue;
    }

    if (dryRun) {
      console.log(`📝 ${template.name} — payload:`);
      console.log(JSON.stringify(buildComponents(template), null, 2));
      continue;
    }

    try {
      const result = await createTemplate(wabaId, accessToken, template);
      console.log(`✅ ${template.name} — submitted (id ${result.id}, status ${result.status || 'PENDING'})`);
    } catch (error) {
      console.error(`❌ ${template.name} — ${error.message}`);
    }
  }

  console.log('\nVariable mappings for Settings → paymentReminders.templateVariableMapping:\n');
  for (const template of selected) {
    console.log(`  ${template.name}: ${JSON.stringify(template.mapping)}`);
  }
  console.log('');
}

run()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
