const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const { DATABASE_URL, JWT_SECRET, PGSSL, PORT = 3000 } = process.env;
const prod = process.env.NODE_ENV === 'production';
if (!DATABASE_URL || !JWT_SECRET) { console.error('DATABASE_URL and JWT_SECRET must be set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
const app = express();
app.set('trust proxy', 1);
app.use(helmet(), express.json({ limit: '100kb' }), cookieParser());

// ---------- helpers ----------
const ROLES = ['employee', 'approver', 'admin', 'auditor'];
const E = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validEmail = e => /^\S+@\S+\.\S+$/.test(e);
const dupe = e => { throw e.code === '23505' ? E(409, 'Email already registered') : e; };
const audit = (db, u, action, type, id, details = {}) =>
  db.query('INSERT INTO audit_logs(org_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)', [u.org_id, u.id, action, type, id, details]);

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

const setCookie = (res, id) =>
  res.cookie('fp_token', jwt.sign({ sub: id }, JWT_SECRET, { expiresIn: '8h' }), { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 8 * 3600 * 1000 });

// Loads the user from the DB on every request, so role changes apply immediately.
const auth = wrap(async (req, res, next) => {
  let user;
  try {
    const { sub, iat } = jwt.verify(req.cookies.fp_token || '', JWT_SECRET);
    user = (await pool.query('SELECT id,org_id,email,name,role,pw_changed_at FROM users WHERE id=$1 AND deleted_at IS NULL', [sub])).rows[0];
    // A password reset signs out every older session.
    if (user && user.pw_changed_at && iat < Math.floor(new Date(user.pw_changed_at).getTime() / 1000)) user = undefined;
    if (user) delete user.pw_changed_at;
  } catch {}
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user; next();
});
const need = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }));
app.param('id', (req, res, next, id) => (/^[0-9a-f-]{36}$/i.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

// ---------- auth ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const orgName = str(req.body.orgName), name = str(req.body.name), email = str(req.body.email).toLowerCase(), pw = req.body.password;
  if (!orgName || !name || !validEmail(email) || typeof pw !== 'string' || pw.length < 8)
    throw E(400, 'Organization, name, a valid email and a password of 8+ characters are required');
  const hash = await bcrypt.hash(pw, 12);
  const u = await tx(async c => {
    const o = (await c.query('INSERT INTO organizations(name) VALUES($1) RETURNING id', [orgName])).rows[0];
    const u = (await c.query("INSERT INTO users(org_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,'admin') RETURNING id,org_id,email,name,role", [o.id, email, name, hash])).rows[0];
    await audit(c, u, 'organization.created', 'organization', o.id, { name: orgName });
    return u;
  }).catch(dupe);
  setCookie(res, u.id);
  res.status(201).json({ user: u });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const u = (await pool.query('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL', [str(req.body.email).toLowerCase()])).rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) throw E(401, 'Invalid email or password');
  await audit(pool, u, 'user.login', 'user', u.id);
  setCookie(res, u.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie('fp_token'); res.json({ ok: true }); });

app.get('/api/auth/me', auth, wrap(async (req, res) => {
  const org = (await pool.query('SELECT name,high_value_threshold FROM organizations WHERE id=$1', [req.user.org_id])).rows[0];
  res.json({ user: req.user, org });
}));

// ---------- organization & users (admin) ----------
app.patch('/api/org', auth, need('admin'), wrap(async (req, res) => {
  const t = Number(req.body.high_value_threshold);
  if (!(t > 0 && t < 1e12)) throw E(400, 'Threshold must be a positive number');
  await pool.query('UPDATE organizations SET high_value_threshold=$1 WHERE id=$2', [t, req.user.org_id]);
  await audit(pool, req.user, 'org.threshold_changed', 'organization', req.user.org_id, { high_value_threshold: t });
  res.json({ ok: true });
}));

app.get('/api/users', auth, need('admin'), wrap(async (req, res) => {
  res.json((await pool.query('SELECT id,email,name,role,created_at FROM users WHERE org_id=$1 AND deleted_at IS NULL ORDER BY created_at', [req.user.org_id])).rows);
}));

app.post('/api/users', auth, need('admin'), wrap(async (req, res) => {
  const name = str(req.body.name), email = str(req.body.email).toLowerCase(), role = req.body.role, pw = req.body.password;
  if (!name || !validEmail(email) || !ROLES.includes(role) || typeof pw !== 'string' || pw.length < 8)
    throw E(400, 'Name, a valid email, a role and a password of 8+ characters are required');
  const u = (await pool.query('INSERT INTO users(org_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,email,name,role,created_at',
    [req.user.org_id, email, name, await bcrypt.hash(pw, 12), role]).catch(dupe)).rows[0];
  await audit(pool, req.user, 'user.created', 'user', u.id, { email, role });
  res.status(201).json(u);
}));

app.patch('/api/users/:id', auth, need('admin'), wrap(async (req, res) => {
  if (!ROLES.includes(req.body.role)) throw E(400, 'Invalid role');
  if (req.params.id === req.user.id) throw E(400, 'You cannot change your own role');
  const u = (await pool.query('UPDATE users SET role=$1 WHERE id=$2 AND org_id=$3 AND deleted_at IS NULL RETURNING id,email,name,role', [req.body.role, req.params.id, req.user.org_id])).rows[0];
  if (!u) throw E(404, 'Not found');
  await audit(pool, req.user, 'user.role_changed', 'user', u.id, { role: u.role });
  res.json(u);
}));

// Admins manage the passwords and accounts of approvers, employees and auditors (not other admins).
const MANAGEABLE = ['employee', 'approver', 'auditor'];
async function managedUser(req) {
  const t = (await pool.query('SELECT id,name,email,role FROM users WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [req.params.id, req.user.org_id])).rows[0];
  if (!t) throw E(404, 'Not found');
  if (!MANAGEABLE.includes(t.role)) throw E(403, 'Only approver, employee and auditor accounts can be managed this way');
  return t;
}

app.patch('/api/users/:id/password', auth, need('admin'), wrap(async (req, res) => {
  const pw = req.body.password;
  if (typeof pw !== 'string' || pw.length < 8) throw E(400, 'Password must be at least 8 characters');
  const t = await managedUser(req);
  await pool.query("UPDATE users SET password_hash=$1, pw_changed_at=date_trunc('second', now()) WHERE id=$2", [await bcrypt.hash(pw, 12), t.id]);
  await audit(pool, req.user, 'user.password_reset', 'user', t.id, { email: t.email });
  res.json({ ok: true });
}));

// Deleting is a soft delete: the person can no longer sign in and the email is freed,
// but their name stays so past requests and the audit log still make sense.
app.delete('/api/users/:id', auth, need('admin'), wrap(async (req, res) => {
  const t = await managedUser(req);
  await tx(async c => {
    await c.query("UPDATE users SET deleted_at=now(), email=$2, password_hash='!', pw_changed_at=now() WHERE id=$1", [t.id, `deleted-${t.id}@removed.invalid`]);
    await audit(c, req.user, 'user.deleted', 'user', t.id, { name: t.name, email: t.email, role: t.role });
  });
  res.json({ ok: true });
}));

// ---------- requests ----------
// Visibility: own requests; admins/auditors see all non-draft in the org; approvers see requests routed to their role.
const VISIBLE = `r.org_id=$1 AND (r.requester_id=$2 OR (r.status<>'draft' AND ($3::boolean OR EXISTS (SELECT 1 FROM approval_assignments a WHERE a.request_id=r.id AND a.role_required=$4))))`;
const vis = u => [u.org_id, u.id, ['admin', 'auditor'].includes(u.role), u.role];
const CATS = ['purchase', 'expense', 'travel', 'other'];

app.get('/api/requests', auth, wrap(async (req, res) => {
  res.json((await pool.query(`SELECT r.*, u.name AS requester_name FROM requests r JOIN users u ON u.id=r.requester_id WHERE ${VISIBLE} ORDER BY r.created_at DESC LIMIT 200`, vis(req.user))).rows);
}));

app.post('/api/requests', auth, need('employee', 'approver', 'admin'), wrap(async (req, res) => {
  const title = str(req.body.title, 120), description = str(req.body.description, 2000), amount = Number(req.body.amount);
  const category = CATS.includes(req.body.category) ? req.body.category : 'purchase';
  if (!title || !(amount > 0 && amount < 1e12)) throw E(400, 'A title and a positive amount are required');
  const r = (await pool.query('INSERT INTO requests(org_id,requester_id,title,description,category,amount) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.user.org_id, req.user.id, title, description, category, amount])).rows[0];
  await audit(pool, req.user, 'request.created', 'request', r.id, { title, amount });
  res.status(201).json(r);
}));

app.get('/api/requests/:id', auth, wrap(async (req, res) => {
  const r = (await pool.query(`SELECT r.*, u.name AS requester_name FROM requests r JOIN users u ON u.id=r.requester_id WHERE r.id=$5 AND ${VISIBLE}`, [...vis(req.user), req.params.id])).rows[0];
  if (!r) throw E(404, 'Not found');
  const steps = (await pool.query('SELECT a.step,a.role_required,a.status,a.comment,a.acted_at,u.name AS acted_by_name FROM approval_assignments a LEFT JOIN users u ON u.id=a.acted_by WHERE a.request_id=$1 ORDER BY a.step', [r.id])).rows;
  const history = (await pool.query("SELECT l.action,l.details,l.created_at,u.name AS actor FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE l.org_id=$1 AND l.entity_type='request' AND l.entity_id=$2 ORDER BY l.id", [req.user.org_id, r.id])).rows;
  const pend = (await pool.query("SELECT id,role_required FROM approval_assignments WHERE request_id=$1 AND status='pending' ORDER BY step LIMIT 1", [r.id])).rows[0];
  const own = r.requester_id === req.user.id;
  const can = !!pend && !own && (req.user.role === 'admin' || req.user.role === pend.role_required);
  res.json({ ...r, steps, history, is_own: own, waiting_on: pend ? pend.role_required : null, can_decide: can, pending_step_id: can ? pend.id : null });
}));

// Routing is decided here, in code, and frozen on the request (chain) at submit time.
app.post('/api/requests/:id/submit', auth, wrap(async (req, res) => {
  await tx(async c => {
    const r = (await c.query('SELECT r.*, o.high_value_threshold FROM requests r JOIN organizations o ON o.id=r.org_id WHERE r.id=$1 AND r.org_id=$2 AND r.requester_id=$3 FOR UPDATE OF r', [req.params.id, req.user.org_id, req.user.id])).rows[0];
    if (!r) throw E(404, 'Not found');
    if (r.status !== 'draft') throw E(409, 'Only drafts can be submitted');
    const chain = Number(r.amount) >= Number(r.high_value_threshold) ? ['approver', 'admin'] : ['approver'];
    await c.query("UPDATE requests SET status='pending_approval', chain=$2, submitted_at=now() WHERE id=$1", [r.id, chain]);
    await c.query('INSERT INTO approval_assignments(org_id,request_id,step,role_required) VALUES($1,$2,0,$3)', [r.org_id, r.id, chain[0]]);
    await audit(c, req.user, 'request.submitted', 'request', r.id, { chain, amount: r.amount });
  });
  res.json({ ok: true });
}));

// ---------- approvals ----------
app.get('/api/approvals/pending', auth, wrap(async (req, res) => {
  res.json((await pool.query(`SELECT a.id, a.step, a.role_required, (r.requester_id=$2) AS own, r.id AS request_id, r.title, r.description, r.amount, r.currency, r.category, r.submitted_at, u.name AS requester_name
    FROM approval_assignments a JOIN requests r ON r.id=a.request_id JOIN users u ON u.id=r.requester_id
    WHERE a.org_id=$1 AND a.status='pending' AND (r.requester_id=$2 OR $3::text='admin' OR a.role_required=$3::text) ORDER BY r.submitted_at`,
    [req.user.org_id, req.user.id, req.user.role])).rows);
}));

app.post('/api/approvals/:id/:action(approve|reject)', auth, wrap(async (req, res) => {
  const approve = req.params.action === 'approve', comment = str(req.body.comment, 1000);
  if (!approve && !comment) throw E(400, 'A comment is required when rejecting');
  const status = await tx(async c => {
    // Row lock: two people deciding at once cannot both complete the same step.
    const a = (await c.query('SELECT a.*, r.requester_id, r.chain FROM approval_assignments a JOIN requests r ON r.id=a.request_id WHERE a.id=$1 AND a.org_id=$2 FOR UPDATE OF a', [req.params.id, req.user.org_id])).rows[0];
    if (!a) throw E(404, 'Not found');
    if (a.status !== 'pending') throw E(409, 'This step has already been decided');
    if (a.requester_id === req.user.id) throw E(403, 'You cannot decide on your own request');
    if (req.user.role !== 'admin' && req.user.role !== a.role_required) throw E(403, 'Your role cannot decide this step');
    await c.query('UPDATE approval_assignments SET status=$2, acted_by=$3, comment=$4, acted_at=now() WHERE id=$1', [a.id, approve ? 'approved' : 'rejected', req.user.id, comment]);
    let next = 'rejected';
    if (approve) {
      if (a.step + 1 < a.chain.length) {
        next = 'pending_approval';
        await c.query('INSERT INTO approval_assignments(org_id,request_id,step,role_required) VALUES($1,$2,$3,$4)', [a.org_id, a.request_id, a.step + 1, a.chain[a.step + 1]]);
      } else next = 'approved';
    }
    await c.query('UPDATE requests SET status=$2, decided_at=CASE WHEN $3::boolean THEN now() END WHERE id=$1', [a.request_id, next, next !== 'pending_approval']);
    await audit(c, req.user, approve ? 'approval.approved' : 'approval.rejected', 'request', a.request_id, { step: a.step, comment, result: next });
    return next;
  });
  res.json({ status });
}));

// ---------- audit & dashboard ----------
app.get('/api/audit', auth, need('admin', 'auditor'), wrap(async (req, res) => {
  res.json((await pool.query(`SELECT l.id,l.action,l.entity_type,l.entity_id,l.details,l.created_at,u.name AS actor, COALESCE(rq.title, tu.name) AS target
    FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id
    LEFT JOIN requests rq ON l.entity_type='request' AND rq.id=l.entity_id
    LEFT JOIN users tu ON l.entity_type='user' AND tu.id=l.entity_id
    WHERE l.org_id=$1 ORDER BY l.id DESC LIMIT 200`, [req.user.org_id])).rows);
}));

app.get('/api/stats', auth, need('admin', 'auditor'), wrap(async (req, res) => {
  const o = req.user.org_id;
  const byStatus = (await pool.query('SELECT status, count(*)::int AS n FROM requests WHERE org_id=$1 GROUP BY status', [o])).rows;
  const avgHours = (await pool.query('SELECT round((avg(extract(epoch FROM decided_at-submitted_at))/3600)::numeric,1) AS h FROM requests WHERE org_id=$1 AND decided_at IS NOT NULL', [o])).rows[0].h;
  const overdue = (await pool.query("SELECT count(*)::int AS n FROM approval_assignments WHERE org_id=$1 AND status='pending' AND created_at < now() - interval '48 hours'", [o])).rows[0].n;
  res.json({ byStatus, avgHours, overdue });
}));

// ---------- static frontend + errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
const dist = path.join(__dirname, '../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Already exists' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  app.listen(PORT, () => console.log(`FlowPilot listening on ${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
