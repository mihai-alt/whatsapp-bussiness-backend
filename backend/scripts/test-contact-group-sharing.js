/**
 * Contact group sharing / status smoke tests.
 * Run: node scripts/test-contact-group-sharing.js
 */
import bcrypt from 'bcryptjs';
import { query, pool } from '../src/db/pool.js';
import { config } from '../src/config.js';

const API = process.env.API_URL || config.apiUrl || 'http://127.0.0.1:4000';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await api('POST', '/api/auth/login', { body: { email, password } });
  if (status !== 200 || !json?.data?.accessToken) {
    throw new Error(`Login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  }
  return json.data.accessToken;
}

async function ensureUser(email, password, name, role) {
  const existing = await query('SELECT id FROM users WHERE email = :email LIMIT 1', { email });
  const password_hash = await bcrypt.hash(password, 10);
  if (existing.length) {
    await query(
      `UPDATE users SET password_hash = :password_hash, role = :role, is_active = 1,
        email_verified = 1, email_verified_at = COALESCE(email_verified_at, NOW()), name = :name
       WHERE id = :id`,
      { id: existing[0].id, password_hash, role, name }
    );
    return existing[0].id;
  }
  const result = await query(
    `INSERT INTO users (email, password_hash, name, role, email_verified, email_verified_at, is_active)
     VALUES (:email, :password_hash, :name, :role, 1, NOW(), 1)`,
    { email, password_hash, name, role }
  );
  return result.insertId;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const results = [];
  const pass = (name) => {
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  };
  const fail = (name, err) => {
    results.push({ name, ok: false, err: String(err.message || err) });
    console.error(`FAIL  ${name}: ${err.message || err}`);
  };

  const adminPass = 'AdminShare@12345';
  const memberAPass = 'MemberAShare@12345';
  const memberBPass = 'MemberBShare@12345';
  await ensureUser('admin_share_test@example.com', adminPass, 'Admin Share', 'admin');
  const memberAId = await ensureUser(
    'member_a_share@example.com',
    memberAPass,
    'Member A Share',
    'member'
  );
  const memberBId = await ensureUser(
    'member_b_share@example.com',
    memberBPass,
    'Member B Share',
    'member'
  );

  const adminToken = await login('admin_share_test@example.com', adminPass);
  const memberAToken = await login('member_a_share@example.com', memberAPass);
  const memberBToken = await login('member_b_share@example.com', memberBPass);
  const suffix = Date.now();

  let groupA;
  let contactId;

  // TEST 1
  try {
    const { status, json } = await api('POST', '/api/contacts/groups', {
      token: memberAToken,
      body: { name: `Share Group ${suffix}`, description: 'test', status: 'ACTIVE', accessMode: 'PRIVATE' },
    });
    assert(status === 201, `create ${status}`);
    groupA = json.data;
    assert(Number(groupA.created_by) === Number(memberAId), 'owner is A');
    assert(groupA.status === 'ACTIVE', 'ACTIVE');
    assert(groupA.access_mode === 'PRIVATE', 'PRIVATE');
    pass('TEST 1 Member A creates private ACTIVE group');
  } catch (e) {
    fail('TEST 1 Member A creates private ACTIVE group', e);
  }

  // TEST 2
  try {
    const { status } = await api('GET', `/api/contacts/groups/${groupA.id}`, { token: memberBToken });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 2 Member B denied private group');
  } catch (e) {
    fail('TEST 2 Member B denied private group', e);
  }

  // TEST 3: SHARED opens to all members (no explicit grant needed)
  try {
    const patch = await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberAToken,
      body: { accessMode: 'SHARED' },
    });
    assert(patch.status === 200, `share mode ${patch.status}`);
    const view = await api('GET', `/api/contacts/groups/${groupA.id}`, { token: memberBToken });
    assert(view.status === 200, `B can view shared ${view.status}`);
    const list = await api('GET', '/api/contacts/groups/list', { token: memberBToken });
    assert(list.status === 200, 'list ok');
    const ids = (list.json.data || []).map((g) => Number(g.id));
    assert(ids.includes(Number(groupA.id)), 'B sees shared group in list');
    pass('TEST 3 Shared: every Member can view');
  } catch (e) {
    fail('TEST 3 Shared: every Member can view', e);
  }

  // TEST 4 + 5 add/remove contact
  try {
    const phone = `+9177${String(suffix).slice(-8)}`;
    const create = await api('POST', '/api/contacts', {
      token: memberBToken,
      body: { name: `Shared Contact ${suffix}`, phone, groupIds: [groupA.id] },
    });
    assert(create.status === 201, `create contact ${create.status} ${JSON.stringify(create.json)}`);
    contactId = create.json.data.id;
    const rem = await api('DELETE', `/api/contacts/groups/${groupA.id}/members/${contactId}`, {
      token: memberBToken,
    });
    assert(rem.status === 200, `remove ${rem.status}`);
    const add = await api('POST', `/api/contacts/groups/${groupA.id}/members`, {
      token: memberBToken,
      body: { contactIds: [contactId] },
    });
    assert(add.status === 200, `re-add ${add.status}`);
    pass('TEST 4-5 Shared member add/remove contacts');
  } catch (e) {
    fail('TEST 4-5 Shared member add/remove contacts', e);
  }

  // TEST 6 edit denied
  try {
    const { status } = await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberBToken,
      body: { name: `Hijack ${suffix}` },
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 6 Shared member cannot edit group');
  } catch (e) {
    fail('TEST 6 Shared member cannot edit group', e);
  }

  // TEST 7 delete denied
  try {
    const { status } = await api('DELETE', `/api/contacts/groups/${groupA.id}`, {
      token: memberBToken,
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 7 Shared member cannot delete group');
  } catch (e) {
    fail('TEST 7 Shared member cannot delete group', e);
  }

  // TEST 8 manage access denied for non-owner
  try {
    const { status } = await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberBToken,
      body: { accessMode: 'PRIVATE' },
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 8 Shared member cannot change access mode');
  } catch (e) {
    fail('TEST 8 Shared member cannot change access mode', e);
  }

  // TEST 9: make private again — B loses access
  try {
    const priv = await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberAToken,
      body: { accessMode: 'PRIVATE' },
    });
    assert(priv.status === 200, `private ${priv.status}`);
    const view = await api('GET', `/api/contacts/groups/${groupA.id}`, { token: memberBToken });
    assert(view.status === 403, `expected 403 got ${view.status}`);
    pass('TEST 9 Private again: Member B denied');
  } catch (e) {
    fail('TEST 9 Private again: Member B denied', e);
  }

  // Re-share then PRIVATE wipe (legacy clear)
  try {
    await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberAToken,
      body: { accessMode: 'SHARED' },
    });
    const viewShared = await api('GET', `/api/contacts/groups/${groupA.id}`, { token: memberBToken });
    assert(viewShared.status === 200, 'B sees shared again');
    const priv = await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberAToken,
      body: { accessMode: 'PRIVATE' },
    });
    assert(priv.status === 200, `private ${priv.status}`);
    const view = await api('GET', `/api/contacts/groups/${groupA.id}`, { token: memberBToken });
    assert(view.status === 403, `B denied after private ${view.status}`);
    pass('TEST 10 SHARED → PRIVATE closes to Members');
  } catch (e) {
    fail('TEST 10 SHARED → PRIVATE closes to Members', e);
  }

  // TEST 11-12 admin access/edit
  try {
    const view = await api('GET', `/api/contacts/groups/${groupA.id}`, { token: adminToken });
    assert(view.status === 200, `admin view ${view.status}`);
    const edit = await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: adminToken,
      body: { description: 'admin edited' },
    });
    assert(edit.status === 200, `admin edit ${edit.status}`);
    pass('TEST 11-12 Admin view/edit private group');
  } catch (e) {
    fail('TEST 11-12 Admin view/edit private group', e);
  }

  // TEST 16 contact into private group by B
  try {
    const { status } = await api('POST', '/api/contacts', {
      token: memberBToken,
      body: {
        name: `Probe ${suffix}`,
        phone: `+9166${String(suffix).slice(-8)}`,
        groupIds: [groupA.id],
      },
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 16 Contact assign to private group denied');
  } catch (e) {
    fail('TEST 16 Contact assign to private group denied', e);
  }

  // TEST 18-19 inactive
  try {
    const inactive = await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberAToken,
      body: { status: 'INACTIVE' },
    });
    assert(inactive.status === 200, `inactive ${inactive.status}`);
    const contactAssign = await api('POST', '/api/contacts', {
      token: memberAToken,
      body: {
        name: `Inactive probe ${suffix}`,
        phone: `+9155${String(suffix).slice(-8)}`,
        groupIds: [groupA.id],
      },
    });
    assert(contactAssign.status === 400, `inactive assign ${contactAssign.status}`);
    const campaign = await api('POST', '/api/campaigns', {
      token: memberAToken,
      body: {
        name: `Camp ${suffix}`,
        contactGroupId: groupA.id,
        saveAsDraft: true,
      },
    });
    assert(campaign.status === 400 || campaign.status === 403, `inactive campaign ${campaign.status}`);
    // reactivate for cleanup
    await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberAToken,
      body: { status: 'ACTIVE' },
    });
    pass('TEST 18-19 Inactive blocks contact + campaign use');
  } catch (e) {
    fail('TEST 18-19 Inactive blocks contact + campaign use', e);
  }

  // TEST 20 multi-group one contact
  try {
    const g2 = await api('POST', '/api/contacts/groups', {
      token: memberAToken,
      body: { name: `Share Group2 ${suffix}` },
    });
    assert(g2.status === 201, `g2 ${g2.status}`);
    await api('POST', `/api/contacts/groups/${g2.json.data.id}/members`, {
      token: memberAToken,
      body: { contactIds: [contactId] },
    });
    const dups = await query(
      'SELECT COUNT(*) AS c FROM contacts WHERE phone_normalized = (SELECT phone_normalized FROM contacts WHERE id = :id)',
      { id: contactId }
    );
    assert(Number(dups[0].c) === 1, 'one contact record');
    pass('TEST 20 Contact in multiple groups stays one record');
    await api('DELETE', `/api/contacts/groups/${g2.json.data.id}`, { token: memberAToken });
  } catch (e) {
    fail('TEST 20 Contact in multiple groups stays one record', e);
  }

  // TEST 22 Shared opens without per-user grants
  try {
    await api('PATCH', `/api/contacts/groups/${groupA.id}`, {
      token: memberAToken,
      body: { accessMode: 'SHARED' },
    });
    const avail = await api('GET', '/api/contacts/groups/available', { token: memberBToken });
    assert(avail.status === 200, 'available ok');
    const ids = (avail.json.data || []).map((g) => Number(g.id));
    assert(ids.includes(Number(groupA.id)), 'shared group in available for B');
    pass('TEST 22 Shared group available to all Members');
  } catch (e) {
    fail('TEST 22 Shared group available to all Members', e);
  }

  // TEST 21 delete group keeps contact
  try {
    const del = await api('DELETE', `/api/contacts/groups/${groupA.id}`, { token: adminToken });
    assert(del.status === 200, `delete ${del.status}`);
    const still = await query('SELECT id FROM contacts WHERE id = :id', { id: contactId });
    assert(still.length === 1, 'contact remains');
    const userStill = await query('SELECT id FROM users WHERE id = :id', { id: memberBId });
    assert(userStill.length === 1, 'user remains');
    pass('TEST 13/21 Admin delete group keeps contacts/users');
  } catch (e) {
    fail('TEST 13/21 Admin delete group keeps contacts/users', e);
  }

  // cleanup contact
  try {
    if (contactId) await query('DELETE FROM contacts WHERE id = :id', { id: contactId });
  } catch {
    /* ignore */
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await pool.end();
  if (failed.length) process.exit(1);
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
