/**
 * Contact group ownership smoke tests (Admin vs Member).
 * Run: node scripts/test-contact-group-access.js
 * Requires API running on API_URL (default http://127.0.0.1:4000).
 */
import bcrypt from 'bcryptjs';
import { query } from '../src/db/pool.js';
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
  const { status, json } = await api('POST', '/api/auth/login', {
    body: { email, password },
  });
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

async function ensureMember(email, password, name) {
  return ensureUser(email, password, name, 'member');
}

async function ensureAdmin(email, password, name) {
  return ensureUser(email, password, name, 'admin');
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

  const adminPass = 'AdminTest@12345';
  const memberAPass = 'MemberA@12345';
  const memberBPass = 'MemberB@12345';
  await ensureAdmin('admin_cg_test@example.com', adminPass, 'Admin CG Test');
  await ensureMember('member_a_test@example.com', memberAPass, 'Member A Test');
  await ensureMember('member_b_test@example.com', memberBPass, 'Member B Test');

  const adminToken = await login('admin_cg_test@example.com', adminPass);
  const memberAToken = await login('member_a_test@example.com', memberAPass);
  const memberBToken = await login('member_b_test@example.com', memberBPass);

  const suffix = Date.now();

  // TEST 1: Admin creates Group A
  let groupA;
  try {
    const { status, json } = await api('POST', '/api/contacts/groups', {
      token: adminToken,
      body: { name: `Admin Group ${suffix}`, description: 'owned by admin' },
    });
    assert(status === 201, `expected 201 got ${status}`);
    groupA = json.data;
    assert(groupA?.can_manage === true, 'admin should manage own group');
    pass('TEST 1 Admin creates Group A');
  } catch (e) {
    fail('TEST 1 Admin creates Group A', e);
  }

  // TEST 2: Member A creates Group B
  let groupB;
  try {
    const { status, json } = await api('POST', '/api/contacts/groups', {
      token: memberAToken,
      body: { name: `MemberA Group ${suffix}`, description: 'owned by A' },
    });
    assert(status === 201, `expected 201 got ${status}`);
    groupB = json.data;
    assert(Number(groupB.created_by) > 0, 'created_by set');
    pass('TEST 2 Member A creates Group B');
  } catch (e) {
    fail('TEST 2 Member A creates Group B', e);
  }

  // TEST 3: Member B cannot view Group B
  try {
    const { status } = await api('GET', `/api/contacts/groups/${groupB.id}`, {
      token: memberBToken,
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 3 Member B view Group B denied');
  } catch (e) {
    fail('TEST 3 Member B view Group B denied', e);
  }

  // TEST 4: Member B cannot edit Group B
  try {
    const { status } = await api('PATCH', `/api/contacts/groups/${groupB.id}`, {
      token: memberBToken,
      body: { name: `Hijacked ${suffix}` },
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 4 Member B edit Group B denied');
  } catch (e) {
    fail('TEST 4 Member B edit Group B denied', e);
  }

  // TEST 5: Member B cannot delete Group B
  try {
    const { status } = await api('DELETE', `/api/contacts/groups/${groupB.id}`, {
      token: memberBToken,
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 5 Member B delete Group B denied');
  } catch (e) {
    fail('TEST 5 Member B delete Group B denied', e);
  }

  // TEST 6: Member B cannot assign contact to Group B
  try {
    const { status } = await api('POST', '/api/contacts', {
      token: memberBToken,
      body: {
        name: `Probe ${suffix}`,
        phone: `+9199${String(suffix).slice(-8)}`,
        groupIds: [groupB.id],
      },
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 6 Member B create contact into Group B denied');
  } catch (e) {
    fail('TEST 6 Member B create contact into Group B denied', e);
  }

  // TEST 7: Member A creates contact into Group B
  let contactRahul;
  try {
    const phone = `+9188${String(suffix).slice(-8)}`;
    const { status, json } = await api('POST', '/api/contacts', {
      token: memberAToken,
      body: {
        name: `Rahul ${suffix}`,
        phone,
        groupIds: [groupB.id],
      },
    });
    assert(status === 201, `expected 201 got ${status} ${JSON.stringify(json)}`);
    contactRahul = json.data;
    assert(
      (contactRahul.groups || []).some((g) => Number(g.id) === Number(groupB.id)),
      'contact in group B'
    );
    pass('TEST 7 Member A creates Rahul in Group B');
  } catch (e) {
    fail('TEST 7 Member A creates Rahul in Group B', e);
  }

  // TEST 8: Member B cannot add Rahul to Group B
  try {
    const { status } = await api('POST', `/api/contacts/groups/${groupB.id}/members`, {
      token: memberBToken,
      body: { contactIds: [contactRahul.id] },
    });
    assert(status === 403, `expected 403 got ${status}`);
    pass('TEST 8 Member B add to Group B denied');
  } catch (e) {
    fail('TEST 8 Member B add to Group B denied', e);
  }

  // TEST 9: Admin adds Rahul to Group A
  try {
    const { status } = await api('POST', `/api/contacts/groups/${groupA.id}/members`, {
      token: adminToken,
      body: { contactIds: [contactRahul.id] },
    });
    assert(status === 200, `expected 200 got ${status}`);
    pass('TEST 9 Admin adds Rahul to Group A');
  } catch (e) {
    fail('TEST 9 Admin adds Rahul to Group A', e);
  }

  // TEST 10: Member A second group + same contact (no duplicate contact)
  let groupC;
  try {
    const createG = await api('POST', '/api/contacts/groups', {
      token: memberAToken,
      body: { name: `MemberA Group2 ${suffix}` },
    });
    assert(createG.status === 201, `group2 create ${createG.status}`);
    groupC = createG.json.data;
    const add = await api('POST', `/api/contacts/groups/${groupC.id}/members`, {
      token: memberAToken,
      body: { contactIds: [contactRahul.id] },
    });
    assert(add.status === 200, `add members ${add.status}`);
    const dupPhone = await api('POST', '/api/contacts', {
      token: memberAToken,
      body: {
        name: 'Dup',
        phone: contactRahul.phone,
        groupIds: [groupC.id],
      },
    });
    assert(dupPhone.status === 409, `expected duplicate 409 got ${dupPhone.status}`);
    pass('TEST 10 Same contact multi-group, no duplicate record');
  } catch (e) {
    fail('TEST 10 Same contact multi-group, no duplicate record', e);
  }

  // TEST 11: Delete group A does not delete Rahul
  try {
    const del = await api('DELETE', `/api/contacts/groups/${groupA.id}`, { token: adminToken });
    assert(del.status === 200, `delete group ${del.status}`);
    const still = await query('SELECT id FROM contacts WHERE id = :id', { id: contactRahul.id });
    assert(still.length === 1, 'contact must remain');
    const inC = await query(
      'SELECT 1 FROM contact_group_members WHERE group_id = :g AND contact_id = :c',
      { g: groupC.id, c: contactRahul.id }
    );
    assert(inC.length === 1, 'still in other group');
    pass('TEST 11 Delete group keeps contact + other memberships');
  } catch (e) {
    fail('TEST 11 Delete group keeps contact + other memberships', e);
  }

  // TEST 12: N/A multi-tenant — single business app; list isolation Member B vs A
  try {
    const listB = await api('GET', '/api/contacts/groups/list', { token: memberBToken });
    assert(listB.status === 200, 'list ok');
    const ids = (listB.json.data || []).map((g) => Number(g.id));
    assert(!ids.includes(Number(groupB.id)), 'Member B must not see Member A group in list');
    pass('TEST 12 Member list isolation (single-business ownership)');
  } catch (e) {
    fail('TEST 12 Member list isolation (single-business ownership)', e);
  }

  // TEST 13: Duplicate group name
  try {
    const { status } = await api('POST', '/api/contacts/groups', {
      token: memberAToken,
      body: { name: groupB.name },
    });
    assert(status === 409, `expected 409 got ${status}`);
    pass('TEST 13 Duplicate group name rejected');
  } catch (e) {
    fail('TEST 13 Duplicate group name rejected', e);
  }

  // TEST 14: Duplicate membership ignored
  try {
    const once = await api('POST', `/api/contacts/groups/${groupB.id}/members`, {
      token: memberAToken,
      body: { contactIds: [contactRahul.id] },
    });
    assert(once.status === 200, `first add ${once.status}`);
    const twice = await api('POST', `/api/contacts/groups/${groupB.id}/members`, {
      token: memberAToken,
      body: { contactIds: [contactRahul.id] },
    });
    assert(twice.status === 200, `second add ${twice.status}`);
    const rows = await query(
      'SELECT COUNT(*) AS c FROM contact_group_members WHERE group_id = :g AND contact_id = :c',
      { g: groupB.id, c: contactRahul.id }
    );
    assert(Number(rows[0].c) === 1, 'exactly one membership row');
    pass('TEST 14 Duplicate membership not duplicated');
  } catch (e) {
    fail('TEST 14 Duplicate membership not duplicated', e);
  }

  // Cleanup test artifacts (best effort)
  try {
    if (groupB?.id) await api('DELETE', `/api/contacts/groups/${groupB.id}`, { token: memberAToken });
    if (groupC?.id) await api('DELETE', `/api/contacts/groups/${groupC.id}`, { token: memberAToken });
    if (contactRahul?.id) {
      await query('DELETE FROM contacts WHERE id = :id', { id: contactRahul.id });
    }
  } catch {
    /* ignore */
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
