/**
 * Bulk-create WhatsApp message templates via the Meta Graph API
 *
 * Reads wabaId / accessToken from the Settings document of a user, then submits
 * every template in src/config/whatsappStarterTemplates.js for approval. Templates that already exist
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

const { LANGUAGE, STARTER_TEMPLATES: TEMPLATES, buildComponents } = require('../src/config/whatsappStarterTemplates');

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
