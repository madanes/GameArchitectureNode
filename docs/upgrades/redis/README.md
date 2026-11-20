# Upgrading Redis (example: 6.x / 7.x -> latest stable 8.x)

Redis holds the live part of the platform: game state, per-room locks, the `game:deadlines` timer ZSET, matchmaking queues, pub/sub fan-out for sockets, the event Streams, and leaderboards. See [data-model.md](../../data-model.md) for the keys.

Confirm the latest stable version at <https://redis.io/downloads/> before starting. Our features (Streams with consumer groups, ZSETs, `SET NX PX`, pub/sub, Lua-free) work on **Redis 6.2+**, and `ioredis` 5 supports Redis 2.6 through 8.

## Licensing note

Redis 7.4+ moved away from the BSD licence (RSALv2/SSPLv1; Redis 8 adds the AGPLv3 option). If your organisation cares, evaluate **Valkey** (BSD fork, protocol-compatible, same steps below) before choosing the target.

## Step 0 - Inventory

```bash
redis-cli INFO server | grep -E "redis_version|redis_mode"
redis-cli INFO persistence | grep -E "aof_enabled|rdb_last_save_time"
redis-cli CONFIG GET save appendonly
redis-cli DBSIZE
grep -n "redis" docker-compose.yml          # image: redis:7-alpine here
```

## Step 1 - Read the release notes

Redis upgrades are mostly drop-in, but read the "breaking changes" for each major you cross: <https://github.com/redis/redis/releases>.

| From -> to | Things to know |
|---|---|
| 6.0 -> 6.2 | New commands only |
| 6.2 -> 7.0 | ACL v2, Redis Functions, `redis.conf` changes, **RDB/AOF format changes** (AOF becomes multi-part). Old Redis cannot read new files: no in-place downgrade |
| 7.0 -> 7.2/7.4 | Mostly additive |
| 7.x -> 8.x | Bundles modules (JSON, Search, TimeSeries, Bloom), new I/O threading, some defaults and commands changed, new licence options. Re-check `redis.conf` and any ACL rules |

Pre-6.2 starting points (5.x, 4.x): hop one major at a time (5 -> 6 -> 7 -> 8).

## Step 2 - Backup

```bash
redis-cli BGSAVE && redis-cli LASTSAVE         # writes dump.rdb
cp /data/dump.rdb ./backup-$(date +%F).rdb     # and appendonlydir/ if AOF is on
```

Practice a restore on a throw-away instance. Note that Redis is mostly **ephemeral** state here: lost live games would be forfeited, matchmaking queues re-form, leaderboards rebuild from Mongo (`league:mmr:{game}` is rebuilt automatically when empty; `stats:lb:*` replays from stats data). Durable truth is in MongoDB, but unfinished `game:pending-finalize` entries and live games exist only in Redis, so do not skip the backup.

## Step 3 - Test on staging

1. Start the target version next to your current one with a copy of the data:
   ```bash
   docker run -d --name redis-new -p 6390:6379 -v "$PWD/restore:/data" redis:8-alpine --appendonly yes
   ```
2. Point a staging stack at it (`REDIS_URL=redis://localhost:6390`).
3. Run `npm test` and `BOT_DELAY_MS=50 MM_BOT_FILL_SEC=3 npm run smoke`.
4. Check what the project uses still works: Streams consumer groups (`XINFO GROUPS events:game`), `ZADD`/`ZRANGEBYSCORE` on `game:deadlines`, pub/sub on `game:*:events`.

## Step 4 - Production upgrade

### A. Single instance (small / dev) - short downtime

Players' sockets drop for the duration; they reconnect and rejoin.

1. Announce a maintenance window.
2. Scale the **game** and **lobby** services to 0 (or stop the stack) so nothing writes.
3. `redis-cli BGSAVE`, wait for completion, copy the dump and AOF.
4. Stop old Redis, change the image tag / package to the new version, keep the same data volume.
5. Start Redis; check `redis-cli INFO server`, `DBSIZE`, `XLEN events:game`.
6. Start the services again. Check `/health` everywhere.

Compose example (`docker-compose.yml`): change `image: redis:7-alpine` to the new tag (e.g. `redis:8-alpine`), keep the `volumes:` and `--appendonly yes`.

### B. With replication / Sentinel (near-zero downtime)

1. Add a **new-version replica** to the existing primary:
   ```bash
   redis-cli -h new-host REPLICAOF old-primary 6379
   redis-cli -h new-host INFO replication     # wait for master_link_status:up and sync done
   ```
   A newer replica can follow an older primary within a supported range; check the release notes of your hop.
2. Upgrade the other replicas the same way, one at a time.
3. Trigger a failover (`SENTINEL FAILOVER <name>` or `CLUSTER FAILOVER`) so a new-version node becomes primary. Apps reconnect automatically (`ioredis` retries); there is a brief pause in writes.
4. Upgrade the old primary last and rejoin it as a replica.

### C. Redis Cluster

Upgrade replicas first, fail over shard by shard, then upgrade the former primaries. Remember the key-naming note in [scaling-and-operations.md](../../scaling-and-operations.md): use hash tags (`game:{id}:state`) before moving to a cluster.

## Step 5 - Client library

```bash
npm ls ioredis
npm update ioredis        # 5.x supports Redis 8
```

If you move to Valkey nothing in `ioredis` changes. After the upgrade confirm:

- the event bus still recovers pending messages on restart (`XPENDING events:game game-service`);
- the 250 ms ticker in the game service still finds due rooms (`ZRANGE game:deadlines 0 -1 WITHSCORES`);
- sockets receive broadcasts across replicas (open two sockets on two game replicas in one room).

## Step 6 - Post-upgrade

```bash
redis-cli INFO server | head
redis-cli INFO stats | grep -E "rejected|evicted|total_error"
redis-cli --latency
redis-cli XINFO GROUPS events:game
redis-cli HLEN game:pending-finalize       # should drain to 0
```

Keep AOF on (`appendonly yes`) and `maxmemory-policy noeviction` for this workload; evicting locks or game state would corrupt games.

## Rollback

- Before the swap: stop the new instance and start the old one with the untouched data volume.
- After a **major** upgrade wrote new RDB/AOF files, an older server may not read them. Restore the pre-upgrade backup (you lose changes since the backup) or fail back through a replica of the old version taken before the cutover. This is why you take a backup and test restoring it.

## Checklist

- [ ] Current version and persistence settings recorded
- [ ] Release notes read for every major crossed
- [ ] RDB/AOF backup taken and restore tested
- [ ] Staging run: `npm test`, smoke test, Streams/ZSET/pub-sub checks
- [ ] `docker-compose.yml` / infra manifests updated to the new tag
- [ ] Rolling replica swap (or maintenance window for single instance)
- [ ] `game:pending-finalize` drains, `/health` green, sockets reconnect
