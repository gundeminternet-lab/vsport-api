// Özel mesajlar: iki kişilik konuşma, maç / skor düellosu / Benim 11'im paylaşımı, mesaj istekleri (alıcı göndereni
// takip etmiyorsa kabul edene kadar en çok 3 mesaj), engelleme, şikâyet ve "kimler yazabilir" ayarı.
//
//   dms/{a_b}                  { members: [a, b], names, photos, state: active | request | declined, requester, pending,
//                                last: { text, from, at }, unread: { uid: n }, readAt: { uid: ms }, updatedMs }
//   dms/{a_b}/messages/{id}    { from, text, attach?, at }
//   social_blocks/{uid}        { blocked: [uid] }
//   social_reports/{id}        { from, kind, target, refId, reason, at }

import { AppError } from './errors.js';
import { cleanMatch } from './social.js';
import { cleanAttach, pairOf } from './social_rules.js';

export const DM_MAX = 500;
export const REQUEST_LIMIT = 3;
const DM_GAP_MS = 1200;
const REPORT_KINDS = new Set(['post', 'comment', 'user', 'dm']);

export class DmService {
  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
    this._last = new Map();
    this._reports = new Map();
  }

  async _me(uid, guest) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Mesajlaşmak için Google ile giriş yap.');
    const u = await this.store.getUser(uid);
    if (!u?.username) throw new AppError('failed-precondition', 'Önce kullanıcı adını belirle.');
    if (u.banned === true) throw new AppError('permission-denied', 'Hesabın mesajlaşmaya kapalı.');
    return u;
  }

  _pair(uid, pair) {
    if (typeof pair !== 'string' || !/^[A-Za-z0-9]{6,64}_[A-Za-z0-9]{6,64}$/.test(pair) || !pair.split('_').includes(uid)) {
      throw new AppError('invalid-argument', 'Geçersiz konuşma.');
    }
    return pair;
  }

  async send({ uid, guest = false, to, text, attach = null }) {
    const me = await this._me(uid, guest);
    if (typeof to !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(to) || to === uid) throw new AppError('invalid-argument', 'Geçersiz alıcı.');
    const body = String(text ?? '').trim();
    const a = attach ? cleanAttach(attach, cleanMatch) : null;
    if (attach && !a) throw new AppError('invalid-argument', 'Paylaşım okunamadı.');
    if (!body && !a) throw new AppError('invalid-argument', 'Mesaj boş olamaz.');
    if (body.length > DM_MAX) throw new AppError('invalid-argument', `Mesaj en fazla ${DM_MAX} karakter olabilir.`);
    const at = this._last.get(uid) ?? 0;
    if (this.now() - at < DM_GAP_MS) throw new AppError('resource-exhausted', 'Biraz yavaş.');
    this._last.set(uid, this.now());
    if (this._last.size > 5000) this._last.clear();
    const [them, myBlocks, theirBlocks, theirProf, theyFollow] = await Promise.all([
      this.store.getUser(to),
      this.store.blocked(uid),
      this.store.blocked(to),
      this.store.getProfile(to).catch(() => null),
      this.store.follows(to, uid).catch(() => false),
    ]);
    if (!them?.username) throw new AppError('not-found', 'Kullanıcı bulunamadı.');
    if (myBlocks.includes(to)) throw new AppError('failed-precondition', 'Bu kullanıcıyı engelledin; önce engeli kaldır.');
    if (theirBlocks.includes(uid)) throw new AppError('permission-denied', 'Bu kullanıcıya mesaj gönderemezsin.');
    const pair = pairOf(uid, to);
    const conv = await this.store.getConv(pair);
    if (!conv && !theyFollow && (theirProf?.dmOpen ?? 'all') === 'following') {
      throw new AppError('permission-denied', 'Bu kullanıcı yalnızca takip ettiklerinden mesaj alıyor.');
    }
    const r = await this.store.sendDm(pair, {
      from: uid,
      to,
      text: body,
      attach: a,
      startAs: theyFollow ? 'active' : 'request',
      names: { [uid]: me.username, [to]: them.username },
      photos: { [uid]: me.photoURL ?? null, [to]: them.photoURL ?? null },
      limit: REQUEST_LIMIT,
      at: this.now(),
    });
    if (r === 'declined') throw new AppError('permission-denied', 'Bu kullanıcı mesaj isteğini reddetti.');
    if (r === 'limit') throw new AppError('failed-precondition', `Mesaj isteği kabul edilene kadar en çok ${REQUEST_LIMIT} mesaj gönderebilirsin.`);
    return { pair, id: r.id, state: r.state };
  }

  async accept({ uid, guest = false, pair }) {
    await this._me(uid, guest);
    const r = await this.store.setConvState(this._pair(uid, pair), uid, 'active');
    if (r === null) throw new AppError('not-found', 'Konuşma bulunamadı.');
    return { state: 'active' };
  }

  async decline({ uid, guest = false, pair }) {
    await this._me(uid, guest);
    const r = await this.store.setConvState(this._pair(uid, pair), uid, 'declined');
    if (r === null) throw new AppError('not-found', 'Konuşma bulunamadı.');
    return { state: 'declined' };
  }

  async read({ uid, pair }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    await this.store.readConv(this._pair(uid, pair), uid, this.now());
    return { ok: true };
  }

  async block({ uid, guest = false, target, block = true }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Engellemek için Google ile giriş yap.');
    if (typeof target !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(target) || target === uid) throw new AppError('invalid-argument', 'Geçersiz kullanıcı.');
    await this.store.setBlock(uid, target, block === true);
    return { blocked: block === true };
  }

  async report({ uid, guest = false, kind, target, refId = null, reason = '' }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Şikâyet için Google ile giriş yap.');
    if (!REPORT_KINDS.has(kind) || typeof target !== 'string' || !/^[A-Za-z0-9_-]{4,130}$/.test(target)) throw new AppError('invalid-argument', 'Geçersiz şikâyet.');
    const n = this._reports.get(uid) ?? { day: '', n: 0 };
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const cnt = n.day === day ? n.n : 0;
    if (cnt >= 20) throw new AppError('resource-exhausted', 'Bugün çok fazla şikâyet gönderdin.');
    this._reports.set(uid, { day, n: cnt + 1 });
    await this.store.addReport({
      from: uid,
      kind,
      target,
      refId: typeof refId === 'string' ? refId.slice(0, 130) : null,
      reason: String(reason ?? '').trim().slice(0, 200),
      at: this.now(),
    });
    return { ok: true };
  }
}

export function createDmStore(db, FieldValue) {
  const conv = (pair) => db.doc(`dms/${pair}`);
  return {
    async getUser(uid) {
      const s = await db.doc(`users/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async getProfile(uid) {
      const s = await db.doc(`social_profiles/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async follows(uid, target) {
      const s = await db.doc(`social_follows/${uid}`).get();
      return s.exists && (s.get('following') ?? []).includes(target);
    },
    async blocked(uid) {
      const s = await db.doc(`social_blocks/${uid}`).get();
      return s.exists ? (s.get('blocked') ?? []) : [];
    },
    async setBlock(uid, target, on) {
      await db.doc(`social_blocks/${uid}`).set({ blocked: on ? FieldValue.arrayUnion(target) : FieldValue.arrayRemove(target) }, { merge: true });
    },
    async getConv(pair) {
      const s = await conv(pair).get();
      return s.exists ? s.data() : null;
    },
    async sendDm(pair, { from, to, text, attach, startAs, names, photos, limit, at }) {
      const ref = conv(pair);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const c = s.exists ? s.data() : null;
        let state = c?.state ?? startAs;
        let pending = Number(c?.pending ?? 0);
        const requester = c?.requester ?? (startAs === 'request' ? from : null);
        if (state === 'declined') {
          if (from === requester) return 'declined';
          state = 'active';
        }
        if (state === 'request') {
          if (from === requester) {
            if (pending >= limit) return 'limit';
            pending += 1;
          } else {
            state = 'active'; // alıcı yanıtladı: istek kabul edilmiş sayılır
          }
        }
        const msg = ref.collection('messages').doc();
        tx.set(msg, { from, text, attach: attach ?? null, at, createdAt: FieldValue.serverTimestamp() });
        tx.set(
          ref,
          {
            members: pair.split('_'),
            names,
            photos,
            state,
            requester,
            pending,
            last: { text: text || (attach ? '[paylaşım]' : ''), from, at },
            unread: { [to]: FieldValue.increment(1), [from]: 0 },
            readAt: { [from]: at },
            updatedMs: at,
          },
          { merge: true },
        );
        return { id: msg.id, state };
      });
    },
    async setConvState(pair, uid, state) {
      const ref = conv(pair);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) return null;
        // Yalnızca isteği alan kabul eder ya da reddeder
        if (s.get('requester') === uid) return s.get('state');
        tx.update(ref, { state, ...(state === 'active' ? { pending: 0 } : {}), [`unread.${uid}`]: 0 });
        return state;
      });
    },
    async readConv(pair, uid, at) {
      try {
        await conv(pair).update({ [`unread.${uid}`]: 0, [`readAt.${uid}`]: at });
      } catch (e) {
        if (e?.code !== 5 && !/no document|not found/i.test(e?.message ?? '')) throw e;
      }
    },
    async addReport(doc) {
      await db.collection('social_reports').add({ ...doc, createdAt: FieldValue.serverTimestamp() });
    },
  };
}
