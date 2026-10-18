// Creates a Hopin admin: a Supabase Auth account (email already confirmed) plus a
// Hopin profile with role 'admin'. Admins cannot sign up through the app; this is
// the only way to make one. Run with: npm run create-admin
import readline from 'node:readline';
import { config } from './config.js';
import { connectDb, disconnectDb, one, query } from './db.js';
import { PHONE_RE, normalizePhone } from './routes/auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (hidden) {
      // Echo "*" instead of the typed characters.
      rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : s.replace(/[^\r\n]/g, '*'));
    }
    rl.question(question, (answer) => {
      rl._writeToOutput = (s) => rl.output.write(s);
      if (hidden) rl.output.write('\n');
      resolve(answer.trim());
    });
  });
}

const fail = async (msg) => {
  console.error(`\n✖ ${msg}`);
  rl.close();
  await disconnectDb().catch(() => {});
  process.exit(1);
};

/** Supabase Auth admin API, authorised with the server-only secret key. */
async function supabaseAdmin(method, path, body) {
  const res = await fetch(`${config.supabase.issuer}/admin${path}`, {
    method,
    headers: { apikey: config.supabase.secretKey, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.message || data.error_description || `Supabase returned ${res.status}`);
  return data;
}

if (!config.supabase.url || !config.supabase.secretKey) {
  await fail('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in server/.env');
}

await connectDb();
console.log('\nCreate a Hopin admin account\n');
const name = await ask('Full name: ');
const email = (await ask('Email: ')).toLowerCase();
const phone = await ask('Mobile number (10 digits): ');
const password = await ask('Password (12+ characters): ', { hidden: true });
const confirm = await ask('Repeat password: ', { hidden: true });

if (!name) await fail('Name is required');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) await fail('That is not a valid email');
if (!PHONE_RE.test(phone.replace(/[\s-]/g, ''))) await fail('Enter a valid 10-digit Indian mobile number');
if (password.length < 12) await fail('Admin passwords must be at least 12 characters');
if (password !== confirm) await fail('Passwords do not match');
if (await one('SELECT 1 FROM users WHERE email = $1 OR phone = $2', [email, normalizePhone(phone)])) {
  await fail('A Hopin profile with that email or phone already exists');
}

let authUser;
try {
  authUser = await supabaseAdmin('POST', '/users', { email, password, email_confirm: true, user_metadata: { full_name: name } });
} catch (err) {
  await fail(`Supabase refused to create the account: ${err.message}`);
}

try {
  await query(`INSERT INTO users (id, name, email, phone, role) VALUES ($1, $2, $3, $4, 'admin')`, [authUser.id, name, email, normalizePhone(phone)]);
} catch (err) {
  // Don't leave a half-made admin behind.
  await supabaseAdmin('DELETE', `/users/${authUser.id}`).catch(() => {});
  await fail(`Could not save the admin profile, so the Supabase account was removed again: ${err.message}`);
}

console.log(`\n✔ Admin created in Supabase Auth and Hopin (${email}). Sign in at ${config.appUrl}`);
rl.close();
await disconnectDb();
