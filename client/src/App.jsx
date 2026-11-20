import { useState, useEffect, useCallback } from 'react';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const money = (n, c = 'PHP') => new Intl.NumberFormat('en-PH', { style: 'currency', currency: c }).format(n);
const when = d => (d ? new Date(d).toLocaleString() : '—');
const ROLES = ['employee', 'approver', 'admin', 'auditor'];
const STATUS = { draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', rejected: 'Rejected' };
const Badge = ({ s }) => <span className={'badge ' + s}>{STATUS[s] || s}</span>;
const Msg = ({ text }) => (text ? <p className="error" role="alert">{text}</p> : null);

const ACTION = {
  'organization.created': 'Organization created', 'user.login': 'Sign-in', 'user.created': 'Person added',
  'user.role_changed': 'Role changed', 'user.password_reset': 'Password reset', 'user.deleted': 'Account deleted',
  'org.threshold_changed': 'Threshold changed', 'request.created': 'Request created', 'request.submitted': 'Request submitted',
  'approval.approved': 'Step approved', 'approval.rejected': 'Step rejected',
};

// Turns an audit event into a plain sentence. `target` is the request title or person's name, when known.
function describe(action, d = {}, target) {
  const req = target ? `"${target}"` : 'this request';
  const step = d.step !== undefined ? `step ${d.step + 1}` : 'a step';
  const quote = d.comment ? ` Comment: "${d.comment}"` : '';
  switch (action) {
    case 'organization.created': return `Created the organization "${d.name}".`;
    case 'user.login': return 'Signed in.';
    case 'user.created': return `Added ${target || d.email} as ${d.role} (${d.email}).`;
    case 'user.role_changed': return `Changed the role of ${target || 'a person'} to ${d.role}.`;
    case 'user.password_reset': return `Reset the password of ${target || d.email || 'a person'}.`;
    case 'user.deleted': return `Deleted the account of ${d.name || target} (${d.role}, ${d.email}).`;
    case 'org.threshold_changed': return `Set the high-value threshold to ${money(d.high_value_threshold)}.`;
    case 'request.created': return `Created request ${req} for ${money(d.amount)}.`;
    case 'request.submitted': return `Submitted request ${req} for ${money(d.amount)}. Needs approval from: ${(d.chain || []).join(', then ')}.`;
    case 'approval.approved': {
      const out = d.result === 'approved' ? ' The request is now fully approved.' : d.result === 'pending_approval' ? ' It now waits for the next approval step.' : '';
      return `Approved ${step} of ${req}.${out}${quote}`;
    }
    case 'approval.rejected': return `Rejected ${step} of ${req}. The request is closed as rejected.${quote}`;
    default: {
      const bits = Object.entries(d).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      return bits.length ? bits.join(', ') : (ACTION[action] || action);
    }
  }
}

function useData(path) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api(path).then(setData).catch(e => setErr(e.message)), [path]);
  useEffect(() => { load(); }, [load]);
  return [data, load, err];
}

function Auth({ onDone }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({});
  const [err, setErr] = useState('');
  const reg = mode === 'register';
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async e => {
    e.preventDefault(); setErr('');
    try { await api('/auth/' + mode, { method: 'POST', body: f }); onDone(); }
    catch (x) { setErr(x.message); }
  };
  return (
    <div className="auth">
      <h1>FlowPilot</h1>
      <p className="muted">Intelligent workflows. Accountable decisions.</p>
      <form className="form" onSubmit={submit}>
        <h2>{reg ? 'Create your organization' : 'Sign in'}</h2>
        {reg && <>
          <label>Organization name<input required onChange={set('orgName')} /></label>
          <label>Your name<input required onChange={set('name')} /></label>
        </>}
        <label>Email<input type="email" required onChange={set('email')} /></label>
        <label>Password<input type="password" required minLength={8} onChange={set('password')} /></label>
        <Msg text={err} />
        <button className="btn">{reg ? 'Create organization' : 'Sign in'}</button>
        <p className="muted">
          {reg ? 'Already have an account? ' : 'New organization? '}
          <button type="button" className="link" onClick={() => { setMode(reg ? 'login' : 'register'); setErr(''); }}>
            {reg ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </form>
    </div>
  );
}

function Detail({ id, onClose, onChanged }) {
  const [r, load, err] = useData('/requests/' + id);
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState('');
  const decide = async action => {
    setMsg('');
    try {
      await api(`/approvals/${r.pending_step_id}/${action}`, { method: 'POST', body: { comment } });
      setComment(''); await load(); onChanged && onChanged();
    } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        {!r ? <p className="muted">{err || 'Loading…'}</p> : <>
          <h2>{r.title}</h2>
          <Badge s={r.status} />
          <p className="amount">{money(r.amount, r.currency)}</p>
          <p>{r.description || 'No description.'}</p>
          <p className="muted">Requested by {r.requester_name} · {r.category}</p>
          {r.can_decide && (
            <div className="decide">
              <h3>Your decision</h3>
              <textarea rows={2} placeholder="Comment (required to reject)" value={comment} onChange={e => setComment(e.target.value)} />
              <Msg text={msg} />
              <div className="actions">
                <button className="btn" onClick={() => decide('approve')}>Approve</button>
                <button className="btn bad" onClick={() => decide('reject')}>Reject</button>
              </div>
            </div>
          )}
          {r.status === 'pending_approval' && !r.can_decide && (
            <p className="note">{r.is_own
              ? `You requested this, so you cannot decide it. It is waiting for ${r.waiting_on === 'admin' ? 'a different admin' : 'a different ' + r.waiting_on + ' or an admin'}.`
              : `Waiting for ${r.waiting_on === 'admin' ? 'an admin' : 'an ' + r.waiting_on} to decide.`}</p>
          )}
          <h3>Approval track</h3>
          {r.steps.length === 0 ? <p className="muted">Not submitted yet.</p> : (
            <ol className="track">
              {r.steps.map(s => (
                <li key={s.step} className={s.status}>
                  <b>Step {s.step + 1}: {s.role_required}</b>{' '}
                  <span className="muted">{s.status === 'pending' ? 'waiting' : `${s.status} by ${s.acted_by_name}, ${when(s.acted_at)}`}</span>
                  {s.comment && <div className="muted">“{s.comment}”</div>}
                </li>
              ))}
            </ol>
          )}
          <h3>History</h3>
          {r.history.map((h, i) => (
            <div className="log" key={i}>{when(h.created_at)}: {describe(h.action, h.details)} <span>({h.actor || 'system'})</span></div>
          ))}
        </>}
      </div>
    </div>
  );
}

function Requests({ me }) {
  const [rows, load, err] = useData('/requests');
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState('');
  const submit = async id => {
    setMsg('');
    try { await api(`/requests/${id}/submit`, { method: 'POST' }); load(); }
    catch (e) { setMsg(e.message); }
  };
  if (!rows) return <p className="muted">{err || 'Loading…'}</p>;
  return (<>
    <h1>Requests</h1>
    <Msg text={msg} />
    {rows.length === 0 ? <p className="empty">No requests yet. Create one from New request.</p> : (
      <div className="scroll"><table className="tbl">
        <thead><tr><th>Title</th><th>Requested by</th><th>Amount</th><th>Status</th><th>Submitted</th><th></th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id} className="pick" onClick={() => setOpen(r.id)}>
            <td>{r.title}</td><td>{r.requester_name}</td><td>{money(r.amount, r.currency)}</td>
            <td><Badge s={r.status} /></td><td>{when(r.submitted_at)}</td>
            <td>{r.status === 'draft' && r.requester_id === me.id &&
              <button className="btn sm" onClick={e => { e.stopPropagation(); submit(r.id); }}>Submit for approval</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    )}
    {open && <Detail id={open} onClose={() => setOpen(null)} onChanged={load} />}
  </>);
}

function NewRequest({ done }) {
  const [f, setF] = useState({ title: '', category: 'purchase', amount: '', description: '' });
  const [msg, setMsg] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const save = async submit => {
    setMsg('');
    try {
      const r = await api('/requests', { method: 'POST', body: f });
      if (submit) await api(`/requests/${r.id}/submit`, { method: 'POST' });
      done();
    } catch (e) { setMsg(e.message); }
  };
  return (<>
    <h1>New request</h1>
    <div className="form">
      <label>Title<input value={f.title} onChange={set('title')} maxLength={120} /></label>
      <div className="inline">
        <label>Category
          <select value={f.category} onChange={set('category')}>
            <option value="purchase">Purchase</option><option value="expense">Expense</option>
            <option value="travel">Travel</option><option value="other">Other</option>
          </select>
        </label>
        <label>Amount (PHP)<input type="number" min="1" step="0.01" value={f.amount} onChange={set('amount')} /></label>
      </div>
      <label>Description<textarea rows={4} value={f.description} onChange={set('description')} /></label>
      <Msg text={msg} />
      <div className="actions">
        <button className="btn" onClick={() => save(true)}>Submit for approval</button>
        <button className="btn sm" style={{ background: '#5d6f75' }} onClick={() => save(false)}>Save draft</button>
      </div>
    </div>
  </>);
}

function Approvals() {
  const [rows, load, err] = useData('/approvals/pending');
  const [c, setC] = useState({});
  const [msg, setMsg] = useState('');
  const act = async (id, action) => {
    setMsg('');
    try { await api(`/approvals/${id}/${action}`, { method: 'POST', body: { comment: c[id] || '' } }); load(); }
    catch (e) { setMsg(e.message); }
  };
  if (!rows) return <p className="muted">{err || 'Loading…'}</p>;
  const mine = rows.filter(r => !r.own), own = rows.filter(r => r.own);
  return (<>
    <div className="row"><h1>Approvals</h1><button className="btn sm" onClick={load}>Refresh</button></div>
    <Msg text={msg} />
    {mine.length === 0 && <p className="empty">Nothing is waiting for you.</p>}
    {mine.map(r => (
      <div className="item" key={r.id}>
        <div className="row"><h3>{r.title}</h3><b>{money(r.amount, r.currency)}</b></div>
        <p className="muted">{r.requester_name} · {r.category} · submitted {when(r.submitted_at)} · step {r.step + 1} ({r.role_required})</p>
        {r.description && <p>{r.description}</p>}
        <textarea rows={2} placeholder="Comment (required to reject)" value={c[r.id] || ''} onChange={e => setC({ ...c, [r.id]: e.target.value })} />
        <div className="actions">
          <button className="btn" onClick={() => act(r.id, 'approve')}>Approve</button>
          <button className="btn bad" onClick={() => act(r.id, 'reject')}>Reject</button>
        </div>
      </div>
    ))}
    {own.length > 0 && (<>
      <h2 style={{ marginTop: 28 }}>Your requests waiting on someone else</h2>
      <p className="muted">Nobody can approve their own request, so another {own.some(r => r.role_required === 'admin') ? 'admin (for the admin step) or approver' : 'approver or admin'} has to decide these.</p>
      {own.map(r => (
        <div className="item" key={r.id}>
          <div className="row"><h3>{r.title}</h3><b>{money(r.amount, r.currency)}</b></div>
          <p className="muted">Step {r.step + 1}: waiting for {r.role_required === 'admin' ? 'a different admin' : 'a different ' + r.role_required + ' or an admin'}</p>
        </div>
      ))}
    </>)}
  </>);
}

function Dashboard({ org, admin, reload }) {
  const [s, loadStats] = useData('/stats');
  const [reqs, loadReqs] = useData('/requests');
  const [pick, setPick] = useState(null);
  const [open, setOpen] = useState(null);
  const [t, setT] = useState(org.high_value_threshold);
  const [msg, setMsg] = useState('');
  const save = async () => {
    setMsg('');
    try { await api('/org', { method: 'PATCH', body: { high_value_threshold: t } }); setMsg('Threshold saved.'); reload(); }
    catch (e) { setMsg(e.message); }
  };
  if (!s) return <p className="muted">Loading…</p>;
  const n = k => s.byStatus.find(x => x.status === k)?.n || 0;
  const tiles = [['Pending approval', n('pending_approval'), 'pending_approval'], ['Approved', n('approved'), 'approved'], ['Rejected', n('rejected'), 'rejected'],
    ['Waiting over 48 hours', s.overdue], ['Average hours to decision', s.avgHours ?? '—']];
  const list = pick && reqs ? reqs.filter(r => r.status === pick) : [];
  return (<>
    <h1>Dashboard</h1>
    <div className="stats">{tiles.map(([l, v, key]) => key ? (
      <button type="button" key={l} className={'stat click' + (pick === key ? ' on' : '')} aria-pressed={pick === key} onClick={() => setPick(pick === key ? null : key)}>
        <b>{v}</b>{l}
      </button>
    ) : <div className="stat" key={l}><b>{v}</b>{l}</div>)}</div>
    {pick && (
      <div className="panel">
        <div className="row"><h3>{STATUS[pick]} ({list.length})</h3><button className="link" onClick={() => setPick(null)}>Close</button></div>
        <div className="plist">
          {!reqs ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">No requests here.</p> : list.map(r => (
            <button type="button" className="pitem" key={r.id} onClick={() => setOpen(r.id)}>
              <span><b>{r.title}</b><small>{r.requester_name} · {r.category} · {pick === 'pending_approval' ? 'submitted ' + when(r.submitted_at) : 'decided ' + when(r.decided_at)}</small></span>
              <span className="amt">{money(r.amount, r.currency)}</span>
            </button>
          ))}
        </div>
        {list.length < n(pick) && <p className="muted">Showing the latest {list.length} of {n(pick)}.</p>}
      </div>
    )}
    {admin && (
      <div className="form">
        <h2>Approval rules</h2>
        <p className="muted">Requests at or above this amount need a second approval from an admin.</p>
        <label>High-value threshold (PHP)<input type="number" min="1" value={t} onChange={e => setT(e.target.value)} /></label>
        <button className="btn" onClick={save}>Save threshold</button>
        {msg && <p className="muted">{msg}</p>}
      </div>
    )}
    {open && <Detail id={open} onClose={() => setOpen(null)} onChanged={() => { loadStats(); loadReqs(); }} />}
  </>);
}

function Audit() {
  const [rows, , err] = useData('/audit');
  if (!rows) return <p className="muted">{err || 'Loading…'}</p>;
  return (<>
    <h1>Audit log</h1>
    <div className="scroll"><table className="tbl">
      <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>What happened</th></tr></thead>
      <tbody>{rows.map(r => (
        <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.actor || '—'}</td><td>{ACTION[r.action] || r.action}</td><td>{describe(r.action, r.details, r.target)}</td></tr>
      ))}</tbody>
    </table></div>
  </>);
}

function Team({ me }) {
  const [users, load, err] = useData('/users');
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'employee' });
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState('');
  const [pwFor, setPwFor] = useState(null);
  const [pw, setPw] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const resetPw = async u => {
    setMsg(''); setOk('');
    try { await api(`/users/${u.id}/password`, { method: 'PATCH', body: { password: pw } }); setPwFor(null); setPw(''); setOk(`Password updated for ${u.name}. They were signed out everywhere.`); }
    catch (x) { setMsg(x.message); }
  };
  const remove = async u => {
    if (!window.confirm(`Delete ${u.name}'s account? They will no longer be able to sign in. Their past requests and the audit history are kept.`)) return;
    setMsg(''); setOk('');
    try { await api('/users/' + u.id, { method: 'DELETE' }); setOk(`${u.name}'s account was deleted.`); load(); }
    catch (x) { setMsg(x.message); }
  };
  const add = async e => {
    e.preventDefault(); setMsg(''); setOk('');
    try { await api('/users', { method: 'POST', body: f }); setF({ ...f, name: '', email: '', password: '' }); load(); }
    catch (x) { setMsg(x.message); }
  };
  const setRole = async (id, role) => {
    setMsg(''); setOk('');
    try { await api('/users/' + id, { method: 'PATCH', body: { role } }); load(); }
    catch (x) { setMsg(x.message); }
  };
  if (!users) return <p className="muted">{err || 'Loading…'}</p>;
  return (<>
    <h1>Team</h1>
    <form className="form" onSubmit={add}>
      <h2>Add a person</h2>
      <div className="inline">
        <label>Name<input required value={f.name} onChange={set('name')} /></label>
        <label>Email<input type="email" required value={f.email} onChange={set('email')} /></label>
        <label>Temporary password<input type="password" required minLength={8} value={f.password} onChange={set('password')} /></label>
        <label>Role<select value={f.role} onChange={set('role')}>{ROLES.map(r => <option key={r}>{r}</option>)}</select></label>
      </div>
      <Msg text={msg} />
      <button className="btn">Add person</button>
    </form>
    <Msg text={msg} />
    {ok && <p className="ok" role="status">{ok}</p>}
    <div className="scroll"><table className="tbl">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Manage</th></tr></thead>
      <tbody>{users.map(u => (
        <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
          <td>{u.id === me.id ? u.role : (
            <select value={u.role} onChange={e => setRole(u.id, e.target.value)}>{ROLES.map(r => <option key={r}>{r}</option>)}</select>
          )}</td>
          <td>{['employee', 'approver', 'auditor'].includes(u.role) ? (pwFor === u.id ? (
            <span className="inline-edit">
              <input type="password" autoComplete="new-password" placeholder="New password (8+)" aria-label={`New password for ${u.name}`} value={pw} onChange={e => setPw(e.target.value)} />
              <button className="btn sm" onClick={() => resetPw(u)}>Save</button>
              <button className="link" onClick={() => { setPwFor(null); setPw(''); }}>Cancel</button>
            </span>
          ) : (
            <span className="inline-edit">
              <button className="link" onClick={() => { setPwFor(u.id); setPw(''); setMsg(''); setOk(''); }}>Reset password</button>
              <button className="link danger" onClick={() => remove(u)}>Delete</button>
            </span>
          )) : <span className="muted">—</span>}</td></tr>
      ))}</tbody>
    </table></div>
  </>);
}

const TABS = [
  ['requests', 'Requests', ROLES],
  ['new', 'New request', ['employee', 'approver', 'admin']],
  ['approvals', 'Approvals', ['approver', 'admin']],
  ['dashboard', 'Dashboard', ['admin', 'auditor']],
  ['audit', 'Audit log', ['admin', 'auditor']],
  ['team', 'Team', ['admin']],
];

export default function App() {
  const [state, setState] = useState(undefined); // undefined = loading, null = signed out
  const [tab, setTab] = useState('requests');
  const load = useCallback(() => api('/auth/me').then(setState).catch(() => setState(null)), []);
  useEffect(() => { load(); }, [load]);

  if (state === undefined) return <p className="muted" style={{ padding: 32 }}>Loading…</p>;
  if (!state) return <Auth onDone={() => { setTab('requests'); load(); }} />;

  const { user, org } = state;
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setState(null); };
  return (
    <div className="app">
      <div className="side">
        <div><div className="brand">FlowPilot</div><div className="org">{org.name}</div></div>
        <nav>
          {TABS.filter(t => t[2].includes(user.role)).map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        <div className="who">{user.name} ({user.role})<br /><button className="link" onClick={logout}>Sign out</button></div>
      </div>
      <main>
        {tab === 'requests' && <Requests me={user} />}
        {tab === 'new' && <NewRequest done={() => setTab('requests')} />}
        {tab === 'approvals' && <Approvals />}
        {tab === 'dashboard' && <Dashboard org={org} admin={user.role === 'admin'} reload={load} />}
        {tab === 'audit' && <Audit />}
        {tab === 'team' && <Team me={user} />}
      </main>
    </div>
  );
}
