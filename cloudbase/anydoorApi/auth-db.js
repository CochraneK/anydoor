// AnyDoor — CloudBase document-DB account store (drop-in replacement for the
// file-backed AuthStore in gateway/server.mjs). All methods are async; the
// gateway awaits the store interface, so the same handler runs unchanged.
//
// Storage layout (two collections, only doc-id reads/writes — no .where()
// queries, which the free-tier document DB rejects for security-rule reasons):
//   anydoor_users   docId = sha256(email)          -> account fields
//   anydoor_tokens  docId = sha256(token)          -> { userId, email, createdAt }
'use strict';

const crypto = require('crypto');
const tcb = require('@cloudbase/node-sdk');

const USERS = 'anydoor_users';
const TOKENS = 'anydoor_tokens';
const PASSWORD_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let dbInstance = null;
let collectionsReady = null;

function getDb() {
  if (!dbInstance) {
    // SYMBOL_CURRENT_ENV is provided by the CloudBase runtime inside a function.
    dbInstance = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV }).database();
  }
  return dbInstance;
}

async function ensureCollections(db) {
  if (!collectionsReady) {
    collectionsReady = Promise.all([
      db.createCollection(USERS).catch(() => {}),
      db.createCollection(TOKENS).catch(() => {}),
    ]);
  }
  return collectionsReady;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomUserToken() {
  return `gw_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function validPassword(value, minLength) {
  return typeof value === 'string' && value.length >= minLength && value.length <= 128;
}

function safeBufferEqual(leftHex, rightHex) {
  try {
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32, PASSWORD_SCRYPT_OPTIONS).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.passwordSalt || !user.passwordHash) return false;
  try {
    const candidate = crypto.scryptSync(password, user.passwordSalt, 32, PASSWORD_SCRYPT_OPTIONS).toString('hex');
    return safeBufferEqual(candidate, user.passwordHash);
  } catch {
    return false;
  }
}

function docIdForEmail(email) {
  // Document ids avoid '@' / '.' entirely.
  return sha256Hex(email);
}

function wrapDbError(error, AuthError) {
  if (error instanceof AuthError) return error;
  console.error('anydoor auth-db error:', error && error.message ? error.message : error);
  return new AuthError('account storage is unavailable', 'auth_store_error', 503);
}

/**
 * Create the CloudBase-backed store. `AuthError` is injected from server.mjs so
 * `instanceof AuthError` checks in the gateway keep working across modules.
 */
function createCloudAuthStore(AuthError, { minPasswordLength = 8 } = {}) {
  const minLength = Math.max(8, Math.min(128, Math.floor(Number(minPasswordLength) || 8)));

  function docToUser(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const user = {
      _id: doc._id,
      id: doc.id,
      email: doc.email,
      createdAt: doc.createdAt,
      passwordSalt: doc.passwordSalt,
      passwordHash: doc.passwordHash,
      tokenHash: doc.tokenHash || '',
      tokenCreatedAt: doc.tokenCreatedAt || doc.createdAt,
    };
    if (typeof doc.name === 'string' && doc.name) user.name = doc.name;
    return user;
  }

  async function fetchUserDoc(userId) {
    const db = getDb();
    const res = await db.collection(USERS).doc(userId).get();
    return docToUser((res.data && res.data[0]) || null);
  }

  async function findByEmail(emailValue) {
    const email = normalizeEmail(emailValue);
    if (!email) return null;
    try {
      return await fetchUserDoc(docIdForEmail(email));
    } catch {
      return null;
    }
  }

  async function findByToken(token) {
    // Runs the same steps as traceTokenLookup; returns the user or null.
    try {
      const trace = await this.traceTokenLookup(token);
      if (trace.result !== 'ok') return null;
      const tokenDocId = sha256Hex(token);
      const db = getDb();
      const res = await db.collection(TOKENS).doc(tokenDocId).get();
      const tokenDoc = (res.data && res.data[0]) || null;
      if (!tokenDoc || !tokenDoc.userId) return null;
      const user = await fetchUserDoc(tokenDoc.userId);
      return user;
    } catch (error) {
      return null;
    }
  }

  async function saveUser(user) {
    const db = getDb();
    await ensureCollections(db);
    const { _id, ...fields } = user;
    await db.collection(USERS).doc(_id).set(fields);
  }

  async function writeTokenDoc(token, user) {
    const db = getDb();
    await ensureCollections(db);
    await db.collection(TOKENS).doc(sha256Hex(token)).set({
      userId: user._id,
      email: user.email,
      createdAt: new Date().toISOString(),
    });
  }

  async function deleteTokenDoc(tokenHashHex) {
    if (!tokenHashHex) return;
    try {
      const db = getDb();
      await db.collection(TOKENS).doc(tokenHashHex).remove();
    } catch {
      // best effort; stale docs are rejected by the tokenHash check anyway
    }
  }

  async function issueToken(user) {
    const token = randomUserToken();
    const oldHash = user.tokenHash || '';
    user.tokenHash = sha256Hex(token);
    user.tokenCreatedAt = new Date().toISOString();
    await writeTokenDoc(token, user);
    return { token, user, oldHash };
  }

  return {
    cloud: true,

    // Diagnostic helper: run the findByToken lookup step by step and report
    // exactly where it fails (used by the /__diag endpoint).
    async traceTokenLookup(token) {
      const steps = [];
      const note = (name, ok, detail) => steps.push({ step: name, ok, ...(detail ? { detail } : {}) });
      if (typeof token !== 'string') return { steps, result: 'not_a_string' };
      note('token_length', token.length >= 16 && token.length <= 256, { length: token.length, prefix: token.slice(0, 3) });
      if (token.length < 16 || token.length > 256) return { steps, result: 'token_length_out_of_range' };
      const tokenDocId = sha256Hex(token);
      note('token_doc_id', true, { tokenDocId });
      try {
        const db = getDb();
        const res = await db.collection(TOKENS).doc(tokenDocId).get();
        const tokenDoc = (res.data && res.data[0]) || null;
        note('read_token_doc', Boolean(tokenDoc), tokenDoc ? { userId: tokenDoc.userId } : { dataShape: JSON.stringify(res.data ?? null).slice(0, 200), requestId: res.requestId ?? null });
        if (!tokenDoc || !tokenDoc.userId) return { steps, result: 'token_doc_missing' };
        const user = await fetchUserDoc(tokenDoc.userId);
        note('read_user_doc', Boolean(user), user ? { id: user.id, email: user.email, tokenHash: user.tokenHash } : { userId: tokenDoc.userId });
        if (!user) return { steps, result: 'user_doc_missing' };
        const matches = !user.tokenHash || user.tokenHash === tokenDocId;
        note('token_hash_match', matches, { userTokenHash: user.tokenHash, tokenDocId });
        if (!matches) return { steps, result: 'stale_token' };
        return { steps, result: 'ok' };
      } catch (error) {
        note('exception', false, { message: String((error && error.message) || error), code: error && error.code, raw: JSON.stringify((error && error.errorInfo) || null).slice(0, 300) });
        return { steps, result: 'exception' };
      }
    },

    async register(emailValue, password, nameValue = '') {
      const email = normalizeEmail(emailValue);
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        throw new AuthError('a valid email is required', 'invalid_email', 400);
      }
      if (!validPassword(password, minLength)) {
        throw new AuthError(`password must be ${minLength}-128 characters`, 'invalid_password', 400);
      }
      if (nameValue !== undefined && nameValue !== null && typeof nameValue !== 'string') {
        throw new AuthError('name must be text', 'invalid_name', 400);
      }
      const name = typeof nameValue === 'string' ? nameValue.trim() : '';
      if (name.length > 80) throw new AuthError('name must be 80 characters or fewer', 'invalid_name', 400);
      try {
        const existing = await findByEmail(email);
        if (existing) throw new AuthError('account already exists', 'account_exists', 409);
        const passwordData = hashPassword(password);
        const createdAt = new Date().toISOString();
        const user = {
          _id: docIdForEmail(email),
          id: crypto.randomUUID(),
          email,
          ...(name ? { name } : {}),
          createdAt,
          passwordSalt: passwordData.salt,
          passwordHash: passwordData.hash,
          tokenHash: '',
          tokenCreatedAt: createdAt,
        };
        const issued = await issueToken(user);
        await saveUser(user);
        return issued;
      } catch (error) {
        throw wrapDbError(error, AuthError);
      }
    },

    findByEmail,
    findByToken,

    async login(emailValue, password) {
      const user = await findByEmail(emailValue);
      if (!user || typeof password !== 'string' || !verifyPassword(password, user)) {
        throw new AuthError('invalid email or password', 'invalid_credentials', 401);
      }
      return this.rotateToken(user);
    },

    async rotateToken(user) {
      if (!user || !user._id) {
        throw new AuthError('account not found', 'account_not_found', 404);
      }
      try {
        const issued = await issueToken(user);
        await saveUser(user);
        await deleteTokenDoc(issued.oldHash);
        return issued;
      } catch (error) {
        throw wrapDbError(error, AuthError);
      }
    },
  };
}

module.exports = { createCloudAuthStore, USERS, TOKENS };
