/**
 * MEMBERS - who belongs to a group space, with which role, and how a new
 * epoch key reaches exactly the remaining members. Everything is ordinary
 * records in the space itself:
 *
 *   _members/<alias>  (private)  {role, xpub, token?, identity?, name?, proof?}
 *                     role: owner | admin | member | removed. Members are
 *                     known by their per-space ALIAS; `identity` + `proof`
 *                     (identity key's signature over sid+alias) is an
 *                     optional, verifiable reveal - visible to members only.
 *   _grants/admins    (private)  the owner-signed admin list (space.js grants)
 *   _keys/<epoch>     (PUBLIC)   {grant, boxes}: the admin-signed epoch grant
 *                     and the new epoch key as ANONYMOUS sealed boxes, one
 *                     per remaining member's alias-X25519 key, padded with
 *                     dummies to a multiple of `pad`. Public so that members
 *                     who do not hold the new key yet still receive it by
 *                     sync; nobody can tell which box is whose.
 *
 * Rules, enforced on every incoming record (`qu.accept`) and every local
 * write (`qu.write.before`) of a group space:
 *   - the owner may do anything; admins (owner-signed list) may write any
 *     `_members` entry, `_grants` and `_keys`;
 *   - a member may only re-write its own entry without changing its role,
 *     and only write its own `_receipts/*` cursor (key = own alias);
 *     a newcomer may create its own entry with a valid admin-signed invite
 *     token (single use);
 *   - every other record needs an active member as author; a removed
 *     member's records written after its removal are refused;
 *   - what cannot be decided yet (membership or admin list not synced) is
 *     DEFERRED (records.js) and re-checked when the member list changes.
 *
 * Local state (device-only, like the identity): `members/groups/<sid>` (how
 * to reopen a group) and `members/keys/<sid>/<epoch>` (epoch keys this
 * device holds) - so a reload keeps every group and every epoch.
 *
 * Removing a member: role -> removed, new epoch (space.rotate), key boxes
 * for everyone else in `_keys`, grant announced to mirrors. The removed
 * member cannot read anything sealed afterwards and - since epochs are
 * admin-signed - cannot block the new epoch at a mirror.
 */
import * as crypto from './crypto.js';
import { Space } from './space.js';

const MEMBERS = '_members';
const GRANTS = '_grants';
const KEYS = '_keys';
const RECEIPTS = '_receipts/';
const ACTIVE = new Set(['owner', 'admin', 'member']);
const BOX_SIZE = 32 + 12 + 32 + 16; // ephemeral pub + iv + 32-byte key + GCM tag
const enc = new TextEncoder();
const b64 = (bytes) => crypto.toBase64(bytes);
const unb64 = (text) => crypto.fromBase64(text);

/** Grants as JSON-safe record values and back. */
export const encodeGrant = (g) =>
  g.kind === 'admins'
    ? { kind: 'admins', seq: g.seq, admins: g.admins.map(b64), sig: b64(g.sig) }
    : { epoch: g.epoch, writePub: b64(g.writePub), by: b64(g.by), sig: b64(g.sig) };
export const decodeGrant = (g) =>
  g.kind === 'admins'
    ? { kind: 'admins', seq: g.seq, admins: g.admins.map(unb64), sig: unb64(g.sig) }
    : { epoch: g.epoch, writePub: unb64(g.writePub), by: unb64(g.by), sig: unb64(g.sig) };

const tokenMessage = (sid, token) => enc.encode(`qu-lite/invite\n${sid}\n${token.id}\n${token.role}`);
const revealMessage = (sid, alias) => enc.encode(`qu-lite/reveal\n${sid}\n${alias}`);

/** @param {{pad?: number}} [options] - key boxes are padded to a multiple of `pad` */
export function members({ pad = 8 } = {}) {
  return (qu) => {
    if (typeof qu.write !== 'function') throw new Error('members(): install records() first');
    const { bus, identity, storage } = qu;
    /** @type {Map<string, Promise<object>>} */
    const managers = new Map();
    const isGroup = (space) => space?.kind === 'group';

    bus.on('qu.accept', async (record, ctx) => {
      if (!isGroup(ctx.space)) return;
      const verdict = await (await manager(ctx.space)).judge(record);
      if (verdict === 'defer') ctx.defer = true;
      else if (verdict !== 'ok') {
        ctx.reason = verdict;
        ctx.stop();
      }
    });
    bus.on('qu.write.before', async (draft) => {
      const space = qu.space(draft.space);
      if (isGroup(space)) await (await manager(space)).checkLocal(draft);
    });

    function manager(space) {
      if (!managers.has(space.id)) managers.set(space.id, createManager(space));
      return managers.get(space.id);
    }

    async function createManager(space) {
      const sid = space.id;
      /** @type {Map<string, {role: string, xpub: string, identity?: string, name?: string, verified: boolean, tokenId?: string, removedAt?: string}>} */
      const list = new Map();
      const me = crypto.toHex((await space.authorFor(identity)).publicKey);
      const myX = await space.aliasX(identity);
      let reindexTimer = null;

      const isAdmin = (alias) => space.isAdmin(crypto.fromHex(alias));
      const scheduleReindex = () => {
        clearTimeout(reindexTimer);
        reindexTimer = setTimeout(() => qu.reindex(space).catch(() => {}), 0);
      };

      async function applyMember(record) {
        const v = record.value ?? {};
        let verified = false;
        if (v.identity && v.proof) verified = await crypto.verify(revealMessage(sid, record.key), unb64(v.proof), crypto.fromHex(v.identity));
        list.set(record.key, {
          raw: v,
          role: v.role,
          xpub: v.xpub,
          identity: verified ? v.identity : undefined,
          name: verified ? v.name : undefined,
          verified,
          tokenId: v.token?.id,
          removedAt: v.role === 'removed' ? record.hlc : undefined,
        });
      }

      async function applyGrants(record) {
        if (record.key === 'admins' && (await space.addAdmins(decodeGrant(record.value)))) {
          await qu.announce(space);
          return true;
        }
        return false;
      }

      async function applyKeys(record) {
        const grant = decodeGrant(record.value.grant);
        if (space.hasEpoch(grant.epoch)) return false;
        for (const box of record.value.boxes ?? []) {
          const key = await crypto.openSealed(myX.privateKey, myX.publicKey, unb64(box));
          if (!key) continue;
          if (!(await space.addEpoch(grant, key))) return false;
          await keepEpoch(sid, grant, key);
          space.useEpoch();
          await qu.announce(space);
          await bus.notify('qu.members.epoch', { space: sid, epoch: grant.epoch });
          qu.resync?.({ space }).catch?.(() => {}); // fetch what the keyring refused while the epoch was unknown
          return true;
        }
        return false;
      }

      async function onRecord(record) {
        let changed = false;
        if (record.path === MEMBERS) {
          await applyMember(record);
          changed = true;
        } else if (record.path === GRANTS) changed = await applyGrants(record);
        else if (record.path === KEYS) changed = await applyKeys(record);
        if (changed) {
          scheduleReindex();
          await bus.notify('qu.members.changed', { space: sid });
        }
      }

      // Initial state from what is already stored: admin list, then the epoch
      // keys this device kept, then members and published key packages.
      for (const r of await qu.query({ space, path: GRANTS })) await applyGrants(r);
      for (const key of await storage.keys(`members/keys/${sid}/`)) {
        const kept = await storage.get(key);
        await space.addEpoch(decodeGrant(kept.grant), unb64(kept.key));
      }
      if (space.latestEpoch > space.epoch) space.useEpoch();
      for (const r of await qu.query({ space, path: MEMBERS })) await applyMember(r);
      for (const r of await qu.query({ space, path: KEYS })) await applyKeys(r);
      bus.on(`qu.record.${sid}`, onRecord);

      async function validToken(token, role, alias) {
        if (!token || token.role !== role || !token.by || !token.sig) return 'no token';
        if (!isAdmin(token.by)) return 'defer'; // the admin list may not have arrived yet
        if (!(await crypto.verify(tokenMessage(sid, token), unb64(token.sig), crypto.fromHex(token.by)))) return 'bad token';
        for (const [other, entry] of list) if (other !== alias && entry.tokenId === token.id) return 'token used';
        return 'ok';
      }

      /** @returns {Promise<'ok'|'defer'|string>} */
      async function judge(record) {
        const author = record.author;
        if (author === space.ownerId) return 'ok';
        const entry = list.get(author);
        if (record.path === MEMBERS) {
          if (isAdmin(author)) return 'ok';
          if (record.key !== author) return 'not allowed';
          if (entry) {
            if (entry.role === 'removed') return 'removed';
            return record.value?.role === entry.role ? 'ok' : 'role change not allowed';
          }
          const verdict = await validToken(record.value?.token, record.value?.role, author);
          return verdict === 'no token' ? 'defer' : verdict; // an admin-written entry may still arrive
        }
        if (record.path === GRANTS || record.path === KEYS) return isAdmin(author) ? 'ok' : 'defer';
        if (record.path.startsWith(RECEIPTS) && record.key !== author) return 'not your receipt';
        if (!entry) return 'defer';
        if (entry.role === 'removed' && record.hlc > entry.removedAt) return 'removed';
        return 'ok';
      }

      async function checkLocal(draft) {
        if (me === space.ownerId) return;
        const entry = list.get(me);
        if (draft.path === MEMBERS) {
          if (isAdmin(me)) return;
          if (draft.key !== me) throw new Error('members: only admins can change other members');
          if (entry && draft.value?.role !== entry.role) throw new Error('members: you cannot change your own role');
          if (!entry && (await validToken(draft.value?.token, draft.value?.role, me)) !== 'ok') throw new Error('members: a valid invite token is required to join');
          return;
        }
        if (draft.path === GRANTS || draft.path === KEYS) {
          if (!isAdmin(me)) throw new Error('members: admins only');
          return;
        }
        if (draft.path.startsWith(RECEIPTS) && draft.key !== me) throw new Error('members: receipts only under your own alias');
        if (!entry || !ACTIVE.has(entry.role)) throw new Error('members: not an active member of this space');
      }

      const writeEntry = (alias, value) => qu.write(space, MEMBERS, value, { key: alias });
      const requireAdmin = () => {
        if (!isAdmin(me)) throw new Error('members: admins only');
      };

      const api = {
        space,
        /** my alias in this space (hex) */
        me,
        /** @returns {Array<{alias: string, role: string, identity?: string, name?: string, verified: boolean, me: boolean}>} */
        list: () => [...list].map(([alias, e]) => ({ alias, role: e.role, identity: e.identity, name: e.name, verified: e.verified, me: alias === me })),
        role: (alias = me) => list.get(alias)?.role ?? null,
        isAdmin: (alias = me) => isAdmin(alias),

        /** Founder only: the owner's own entry. */
        async found() {
          if (me !== space.ownerId) throw new Error('members: only the owner founds a space');
          if (!list.has(me)) await writeEntry(me, { role: 'owner', xpub: crypto.toHex(myX.publicKey) });
        },

        /**
         * Creates an invite (admin only). With `identityPub` it is also
         * delivered to that person's inbox (needs the inbox plugin).
         * @returns {Promise<object>} the invite: {secret, owner, epochs, admins, token}
         */
        async invite(identityPub, { role = 'member' } = {}) {
          requireAdmin();
          if (!ACTIVE.has(role) || role === 'owner') throw new Error(`members: cannot invite as ${role}`);
          const token = { id: crypto.toHex(crypto.randomBytes(8)), role, by: me };
          token.sig = b64(await crypto.sign(tokenMessage(sid, token), (await space.authorFor(identity)).privateKey));
          const grants = await space.grants();
          const invite = {
            type: 'invite',
            secret: b64(space.secret),
            owner: space.ownerId,
            epochs: grants.filter((g) => g.epoch > 0).map((g) => ({ grant: encodeGrant(g), key: b64(space.epochKeys(g.epoch).key) })),
            admins: grants.filter((g) => g.kind === 'admins').map(encodeGrant),
            token,
          };
          if (identityPub) {
            if (!qu.inbox) throw new Error('members.invite: install inbox() to invite by pubkey');
            await qu.inbox.send(identityPub, invite);
          }
          return invite;
        },

        /** Joins with an invite token (writes the own entry). */
        async join(token) {
          if (list.has(me)) return;
          await writeEntry(me, { role: token.role, xpub: crypto.toHex(myX.publicKey), token });
        },

        /** Optional, verifiable reveal of the real identity (to members only). */
        async reveal({ name } = {}) {
          const entry = list.get(me);
          if (!entry) throw new Error('members: join first');
          const proof = b64(await crypto.sign(revealMessage(sid, me), identity.privateKey));
          await writeEntry(me, { role: entry.role, xpub: entry.xpub, identity: crypto.toHex(identity.publicKey), name, proof });
        },

        /** Owner: set a member's role; admin changes also re-sign the admin list. */
        async promote(alias, role) {
          if (me !== space.ownerId) throw new Error('members: only the owner changes roles');
          const entry = list.get(alias);
          if (!entry) throw new Error('members: unknown member');
          await writeEntry(alias, { ...rawEntry(entry), role });
          entry.role = role;
          const admins = [...list].filter(([, e]) => e.role === 'admin').map(([a]) => crypto.fromHex(a));
          const grant = await space.setAdmins(await space.authorFor(identity), admins);
          await qu.write(space, GRANTS, encodeGrant(grant), { key: 'admins' });
          await qu.announce(space);
        },

        /** Admin: remove a member and move everyone else to a new epoch. */
        async remove(alias) {
          requireAdmin();
          const entry = list.get(alias);
          if (!entry) throw new Error('members: unknown member');
          if (alias === space.ownerId) throw new Error('members: the owner cannot be removed');
          await writeEntry(alias, { ...rawEntry(entry), role: 'removed' });
          return rotate();
        },

        /** Admin: new epoch for all active members (also useful after a suspected key leak). */
        rotate,
      };

      async function rotate() {
        requireAdmin();
        const { epoch, key, grant } = await space.rotate(await space.authorFor(identity));
        await keepEpoch(sid, grant, key);
        const recipients = [...list.values()].filter((e) => ACTIVE.has(e.role) && e.xpub);
        const boxes = [];
        for (const e of recipients) boxes.push(b64(await crypto.sealTo(crypto.fromHex(e.xpub), key)));
        while (boxes.length === 0 || boxes.length % pad !== 0) boxes.push(b64(crypto.randomBytes(BOX_SIZE)));
        for (let i = boxes.length - 1; i > 0; i--) {
          const j = crypto.randomBytes(1)[0] % (i + 1);
          [boxes[i], boxes[j]] = [boxes[j], boxes[i]];
        }
        // Published under the OLD epoch: everyone can still receive it.
        await qu.write(space, KEYS, { grant: encodeGrant(grant), boxes }, { key: String(epoch), visibility: 'public' });
        space.useEpoch(epoch);
        await qu.announce(space);
        await bus.notify('qu.members.epoch', { space: sid, epoch });
        return epoch;
      }

      // used by the bus hooks above; not part of the public manager API
      Object.defineProperties(api, { judge: { value: judge }, checkLocal: { value: checkLocal } });
      return api;
    }

    const keepEpoch = (sid, grant, key) => storage.set(`members/keys/${sid}/${grant.epoch}`, { grant: encodeGrant(grant), key: b64(key) });
    const keepGroup = (space) => storage.set(`members/groups/${space.id}`, { secret: b64(space.secret), owner: space.ownerId });

    /** The stored value of an entry (keeps the member's own reveal when an admin changes the role). */
    const rawEntry = (e) => ({ ...e.raw });

    /** A new group founded by this identity (joined, owner entry written). */
    async function createGroup(options = {}) {
      const space = qu.join(await Space.create(identity), options);
      await keepGroup(space);
      await (await manager(space)).found();
      if (typeof qu.watch === 'function') await qu.watch({ space });
      return space;
    }

    /**
     * Opens a group from an invite (link or inbox): epochs and admin list
     * are verified, then the own member entry is written with the token.
     */
    async function acceptInvite(invite, options = {}) {
      const space = await Space.open(unb64(invite.secret), { owner: invite.owner });
      for (const g of invite.admins ?? []) await space.addAdmins(decodeGrant(g));
      for (const { grant, key } of [...(invite.epochs ?? [])].sort((a, b) => a.grant.epoch - b.grant.epoch)) {
        if (await space.addEpoch(decodeGrant(grant), unb64(key))) await keepEpoch(space.id, decodeGrant(grant), unb64(key));
      }
      space.useEpoch();
      await keepGroup(space);
      qu.join(space, options);
      if (typeof qu.watch === 'function') await qu.watch({ space });
      const m = await manager(space);
      if (invite.token) await m.join(invite.token);
      return space;
    }

    /** Reopens every group this device has created or joined (after a reload). @returns {Promise<Space[]>} */
    async function restoreGroups(options = {}) {
      const out = [];
      for (const key of await storage.keys('members/groups/')) {
        const sid = key.split('/')[2];
        if (qu.space(sid)) {
          out.push(qu.space(sid));
          continue;
        }
        const kept = await storage.get(key);
        const space = qu.join(await Space.open(unb64(kept.secret), { owner: kept.owner }), options);
        await manager(space);
        if (typeof qu.watch === 'function') await qu.watch({ space });
        out.push(space);
      }
      return out;
    }

    Object.assign(qu, { members: manager, createGroup, acceptInvite, restoreGroups });
    return { members: manager, createGroup, acceptInvite, restoreGroups };
  };
}
