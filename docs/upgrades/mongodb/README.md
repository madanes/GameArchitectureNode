# Upgrading MongoDB (example: 4.4 / 5.0 / 6.0 / 7.0 -> latest stable)

MongoDB is the durable store: users, rooms, finished matches, stats, ratings, wallets and the reward ledger (each service has its own database, see [data-model.md](../../data-model.md)). Data loss here is not recoverable from Redis, so this is the upgrade to be most careful with.

Confirm the latest stable major at <https://www.mongodb.com/docs/manual/release-notes/>. At the time of writing the 8.x series is current.

## The one rule: **one major version at a time**

MongoDB only supports upgrading from the previous major release. 4.4 -> 8.0 must go 4.4 -> 5.0 -> 6.0 -> 7.0 -> 8.0, setting the **Feature Compatibility Version (FCV)** after each hop. Each hop is the same procedure below.

Check the exact path for your starting point: <https://www.mongodb.com/docs/manual/release-notes/>.

## Step 0 - Inventory

```bash
mongosh --eval 'db.version()'
mongosh --eval 'db.adminCommand({getParameter:1, featureCompatibilityVersion:1})'
mongosh --eval 'rs.status().ok'          # replica set? standalone?
mongosh --eval 'db.adminCommand({listDatabases:1}).databases.map(d=>d.name)'
grep -n "mongo" docker-compose.yml        # image: mongo:7 here
```

Expected databases: `auth`, `lobby`, `game`, `stats`, `league`, `rewards`.

Verify the **driver** supports the target server. We use the Node `mongodb` driver 6.x (`packages/common/package.json`), which supports servers 3.6 -> 8.x. Check the compatibility table at <https://www.mongodb.com/docs/drivers/node/current/compatibility/> and bump the driver if needed (`npm update mongodb`).

## Step 1 - Prerequisites per hop

- Current FCV equals the current major (e.g. on 6.0 binaries set FCV "6.0" before going to 7.0).
- Read the "Compatibility changes" and "Upgrade" pages for the target version.
- Deprecated/removed features to check across hops: legacy `ensureIndex`, MMAPv1 (gone in 4.2), old authentication mechanism `MONGODB-CR` (removed in 4.0, SCRAM required), `mongo` shell replaced by `mongosh`, removed commands in release notes.
- Disk: ensure free space of at least the data size for the backup and for upgrade rebuilds.

## Step 2 - Backup (always, every hop)

```bash
mongodump --uri "$MONGO_URL" --gzip --out ./backup-$(date +%F)
# or volume snapshot / Atlas / filesystem snapshot with journaling on
```

**Test the restore** on a scratch instance:

```bash
mongorestore --uri "mongodb://localhost:27099" --gzip ./backup-YYYY-MM-DD
```

## Step 3 - Rehearse on staging

1. Restore the backup into a staging MongoDB of the **old** version.
2. Run the hop there. Start the stack against it (`MONGO_URL=...`).
3. `npm test`, `BOT_DELAY_MS=50 MM_BOT_FILL_SEC=3 npm run smoke`.
4. Verify the project-specific behaviours that touch Mongo:
   - unique indexes: `auth.users {username,email}`, `lobby.rooms {code}`, `league.ratings {userId,game}`, `stats.player_stats {userId,game}`;
   - idempotent inserts: `game.matches._id = roomId`, `*.processed_matches`, `rewards.ledger._id = idempotencyKey` (duplicate key errors are expected and handled);
   - atomic room joins (`findOneAndUpdate` in lobby);
   - the end-of-game write (kill Mongo briefly while a game ends: the match should sit in `game:pending-finalize` and be stored after Mongo returns).

## Step 4 - Upgrade one hop

### A. Standalone (dev / small)

Short downtime (the game keeps matches that finish during it in `game:pending-finalize`, but REST calls will fail).

1. Take a backup.
2. Stop the services that write to Mongo (or the whole stack).
3. Stop `mongod`. Replace the binaries / image tag (e.g. `mongo:7` -> `mongo:8` in `docker-compose.yml`, **one major at a time**) keeping the same data volume.
4. Start `mongod`. Confirm: `db.version()`.
5. Raise the FCV:
   ```js
   db.adminCommand({ setFeatureCompatibilityVersion: "8.0", confirm: true })   // use the major you just installed
   ```
   Until you do this, the old on-disk format stays, which allows a binary downgrade. After it you can no longer downgrade the binary.
6. Start the services; check `/health`.

Soak for a few days at the new binary with the **old** FCV before raising the FCV if you want the cheapest rollback.

### B. Replica set (recommended for anything real, near-zero downtime)

Rolling procedure:

1. Backup. Check `rs.status()` is healthy and `rs.printSecondaryReplicationInfo()` shows no lag.
2. Upgrade **secondaries one at a time**: stop `mongod`, install the new binaries, start it, wait until it is `SECONDARY` and caught up.
3. Step down the primary: `rs.stepDown()`. The driver retries writes (`retryWrites`) and reads; a one-to-few-second blip.
4. Upgrade the former primary like the other nodes.
5. Raise the FCV on the (new) primary:
   ```js
   db.adminCommand({ setFeatureCompatibilityVersion: "8.0", confirm: true })
   ```
6. Repeat the whole procedure for the next major if there is one.

Make sure `MONGO_URL` lists the replica set / uses `replicaSet=` and that `retryWrites=true` (default) so the Node driver rides through the failover.

### C. Sharded cluster

Follow the vendor's sharded procedure (disable balancer, upgrade config servers, then shards, then `mongos`). We do not shard yet; see the scaling notes.

## Step 5 - Indexes and queries

After upgrading, rebuild nothing blindly; instead check:

```js
db.getSiblingDB("lobby").rooms.getIndexes()
db.getSiblingDB("league").ratings.explain("executionStats").find({game:"ludo"}).sort({rating:-1}).limit(20)
```

Index definitions are created at startup by the services (`createIndex` is idempotent), so a restart of each service re-ensures them.

## Step 6 - Post-upgrade verification

```bash
mongosh --eval 'db.version()'
mongosh --eval 'db.adminCommand({getParameter:1, featureCompatibilityVersion:1})'
npm test && npm run smoke
```

Watch for a day: slow queries (`db.setProfilingLevel(1, 100)`), connection counts, `game:pending-finalize` size in Redis, error logs mentioning `MongoServerError`.

## Rollback

| Situation | What to do |
|---|---|
| Binary upgraded, FCV **not** raised | Stop `mongod`, reinstall the previous binary, start. Data files are still compatible |
| FCV already raised | Binary downgrade is **not** supported. Restore the pre-upgrade backup (`mongorestore`) to an old-version server or fail over to an old-version replica kept aside; you lose writes after the backup |
| Driver issue only | Pin the previous `mongodb` driver version in `package.json` and redeploy |

## Checklist

- [ ] Version path planned (one major at a time) and release notes read
- [ ] Driver compatibility confirmed (`npm ls mongodb`)
- [ ] `mongodump` taken **and restore tested**
- [ ] Rehearsed on staging, `npm test` + smoke pass
- [ ] Rolling upgrade: secondaries -> step down -> former primary
- [ ] FCV raised only after the new binary is proven
- [ ] `docker-compose.yml` / infra manifests updated, change committed
- [ ] Post-checks: indexes, slow queries, `game:pending-finalize` drained
