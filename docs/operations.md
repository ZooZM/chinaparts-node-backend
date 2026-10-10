# Operations

How the Reels service is hosted, deployed, watched, backed up and measured. Written for whoever is
on call. The design reasons are in [research.md](../specs/002-chinaparts-reels-service/research.md)
(R10 for scaling, R13 for screening, R14 for push, R17 for hosting).

## Hosting and data residency (R17)

Everything that **stores** reels data runs in Saudi Arabia: the API and worker containers,
MongoDB, Redis, the object storage (public and private buckets), the backups, and the logs.

Only two things may leave the Kingdom, and nothing else may:

| What | Where it goes | Why it is allowed |
|------|---------------|-------------------|
| Videos and descriptions, for automatic screening | The screening provider (Sightengine) | FR-073. The provider must delete the submission as soon as it answers (R13). |
| Push notifications | Firebase Cloud Messaging and Apple's push service | FR-073a. A push carries only the text in the recipient's language, the actor's public name, and ids. |

The rules that follow from this:

- **No logs, error reports or traces leave the Kingdom.** Do not add Sentry, Datadog, Logtail or a
  similar hosted service, and do not ship container logs anywhere outside the server. A log line can
  carry a reel id, an account id or an error with a user's text in it.
- **GitHub Actions handles code only.** It SSHes in; the server builds and runs the containers.
  GitHub stores workflow output outside the Kingdom, so a workflow must never print logs, response
  bodies or data. The diagnostics workflow is built that way (below).
- **Backups go to the private bucket in the Kingdom** and nowhere else.
- China Parts' own MySQL is read, not copied. The service holds no China Parts table except as
  short-lived cache entries in Redis.

## Deploying

Every push to `main` runs [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): it
SSHes to the server, mirrors `origin/main` with `git fetch` and `git reset --hard`, runs
`docker compose up -d --build api worker`, prunes old images, and waits for `/health/ready` to answer
200. It prints only the status code. MongoDB and Redis are not rebuilt, so their data stays.

It can also be run by hand from the Actions tab (**Run workflow**).

The repository needs these secrets:

| Secret | Value |
|--------|-------|
| `SERVER_IP` | The server's address |
| `SERVER_USER` | The SSH user |
| `SSH_PRIVATE_KEY` | The private key for that user |
| `SERVER_PORT` | The SSH port |
| `DEPLOY_PATH` | The checkout directory on the server, the one holding `docker-compose.yml` and `.env` |

`.env` lives on the server only and is never committed. The hard reset does not touch it, because
it is ignored by git. After changing it, redeploy (or `docker compose up -d api worker`) so the
containers pick it up.

If a deploy fails with "did not become ready", look at the cause over SSH (next section) rather
than re-running blindly.

## Looking at the server

### Status and health: the diagnostics workflow

Run **Server diagnostics** from the Actions tab. It prints:

- `docker compose ps`
- the `/health/ready` answer (each dependency's status: MongoDB, Redis, China Parts' MySQL) and `/health/live`
- the free disk space
- the **names** of the variables in `.env`, never their values

It never prints container logs.

`/health/ready` answers 503 `NOT_READY` and names the dependency that is down. While China Parts'
MySQL is down, signed-in requests answer 503 `UPSTREAM_UNAVAILABLE` (not 401), so an outage there
is never mistaken for a bad sign-in.

### Logs: over SSH only

```bash
ssh <user>@<server>
cd <DEPLOY_PATH>

docker compose logs -f --since 15m api worker
docker compose logs --since 1h worker | grep -i error
```

Do not paste log output into a chat tool, a ticket system or a CI job that is hosted abroad. If a
log excerpt is needed in a ticket, redact ids, names and text first.

Useful structured lines (JSON, one per event):

| `event` | From | Fields |
|---------|------|--------|
| `reel.published` | The worker, after screening | `reelId`, `publishLatencyMs` |
| `push.delivered` | The worker, after a notification is sent | `type`, `sent`, `deliveryLatencyMs` |

## Scaling: `WORKER_ROLE`

The API and the worker run the same image, and `WORKER_ROLE` decides which of them starts queue
processors and scheduled jobs (R10):

| Value | Serves requests | Runs queue processors and schedules |
|-------|-----------------|-------------------------------------|
| `api` | yes | no |
| `worker` | yes (the port is not exposed) | yes |
| `all` | yes | yes (the default; what a single instance and the tests use) |

`docker-compose.yml` runs one `api` container and one `worker` container. To add API capacity, run
more `api` containers behind the reverse proxy: they never pull a job. Scheduled jobs (the
standing sync, the sweeps) are registered by name when a worker starts, so a second worker does not
double them, but it does share the queue's load. Keep at least one worker running at all times:
without it nothing is screened, so uploads stay in `pending_moderation`, no push is sent, and
suspensions are not picked up.

## Backups

[`scripts/backup-mongo.sh`](../scripts/backup-mongo.sh) streams `mongodump --archive --gzip` out of
the `mongo` container straight into the private bucket under `backups/`, then removes backups
older than 14 days (`BACKUP_RETENTION_DAYS` changes that). It needs the `aws` CLI on the host and
reads the same `.env` as the stack (`MONGO_ROOT_*`, `MONGO_DB_NAME`, `S3_*`).

Schedule it nightly from cron on the server:

```cron
17 2 * * *  cd <DEPLOY_PATH> && ./scripts/backup-mongo.sh >> /var/log/reels-backup.log 2>&1
```

Redis holds only caches, queues and the exclusion sets, all rebuilt from MongoDB and China Parts,
so it is not backed up. The public and private buckets hold the media and are covered by the
storage provider's own durability; confirm that setting (versioning or replication **within the
Kingdom**) when the bucket is created.

**Restore** (to a scratch database first, to check the backup is good):

```bash
aws --endpoint-url "$S3_ENDPOINT" s3 cp "s3://$S3_PRIVATE_BUCKET/backups/<file>.archive.gz" - \
  | docker compose exec -T mongo mongorestore \
      --username "$MONGO_ROOT_USERNAME" --password "$MONGO_ROOT_PASSWORD" \
      --authenticationDatabase admin --archive --gzip \
      --nsFrom 'reels.*' --nsTo 'reels_restore_check.*'
```

Run a restore into the scratch name at least once before launch, and after any change to the
backup script.

## Residency audit (SC-015)

Do this before launch and again after any change of provider, region or monitoring tooling. Record
the result in [launch-gates.md](launch-gates.md).

1. **Where the data is stored.** For each of these, write down the provider, the region, and the
   evidence (console screenshot, invoice, or the provider's written confirmation): the server
   hosting the containers and their volumes, MongoDB's volume, Redis's volume, the public bucket,
   the private bucket (and its backups), and the place the container logs are written. All of them
   must be in Saudi Arabia.
2. **What leaves.** Check the server's outbound traffic against the allow-list: the screening
   provider, Firebase and Apple push, China Parts' MySQL host, and the in-Kingdom storage endpoint.
   An egress firewall rule is the strongest evidence; failing that, sample connections over a
   working day: `ss -tnp state established | awk '{print $4}' | sort | uniq -c`.
3. **No foreign monitoring.** Run the diagnostics workflow and read the list of env variable
   names. There must be no Sentry, Datadog, OpenTelemetry-exporter or similar variable, and
   `package.json` must hold none of their SDKs.
4. **The screening provider keeps nothing.** The Sightengine account has immediate deletion on, the
   data processing addendum is signed, and there is a written confirmation that no copy of a
   submission is kept (R13, FR-073). This is a document, not a test.
5. **The push payload carries only what FR-073a allows.** A push is one of four types:
   `newFollower`, `reelLike`, `reelMention`, `reelRejected`. Each may carry: the title and body in
   the recipient's language, the actor's public name, and reel and account ids. Prove it twice:
   - Run `npm test -- push-payload` and `npm run test:e2e -- notifications`. The first pins the exact
     keys each type may carry; the second captures what is handed to Firebase and fails on a
     description, a handle, an email or a phone number.
   - On staging, with real FCM credentials, trigger each of the four types once and read the
     delivered notification on a device. Nothing in it beyond the allowed fields.

## Latency report (SC-004, SC-010)

The worker logs how long each reel took from upload to published (`publishLatencyMs`) and how long
each notification took from the event to being sent (`deliveryLatencyMs`). The report reads those
over SSH and prints only numbers, so nothing leaves the server:

```bash
./scripts/metrics/latency-report.sh <user>@<server> <DEPLOY_PATH> 168h
```

```
window: last 168h
                                      count   p50 (ms)   p95 (ms)   max (ms)
SC-004 upload to published              412       8200      31000      94000
SC-010 notification to sent            1893        140        900       4200
```

Targets: SC-004 p95 under 120 000 ms, SC-010 p95 under 30 000 ms. Run it on the server itself with
`./scripts/metrics/latency-report.sh - "$PWD" 168h`. Docker keeps logs only as long as its log
driver is configured to; set `max-size` and `max-file` in the daemon's `log-opts` high enough that
the window you ask for is really there.

`deliveryLatencyMs` counts from when the job was queued, so it includes any retry delay: a push
that needed three attempts shows up in the tail, which is what SC-010 should see.

## Load test (SC-003, R9)

[`scripts/load/feed.k6.js`](../scripts/load/feed.k6.js) runs two scenarios for five minutes each:

- **feed**: 500 virtual users page through `GET /api/reels`, half of them signed in and half guests
  with their own installation id. Threshold: p95 under 1000 ms (SC-003).
- **search**: 20 virtual users call `GET /api/users/search` (EP26). Threshold: p95 under 300 ms
  (R9). If it fails, the fix is a token collection built like `hashtag_stats`, not a bigger server.

```bash
k6 run \
  -e BASE_URL=https://<staging-host> \
  -e SIGNED_IN_TOKENS='Bearer 11|<secret>,Bearer 12|<secret>' \
  -e SEARCH_TOKEN='Bearer 11|<secret>' \
  scripts/load/feed.k6.js
```

Rules for a run that counts:

- Run it against a **staging stack in the Kingdom** with production-sized data (the real number of
  reels, accounts and follows, restored from a backup if need be). A load test against an empty
  database proves nothing.
- Use real sign-in tokens from the staging China Parts, or the signed-in half is not tested.
- **Raise the rate limits on staging for the run**, and only there. The throttles are per address
  (`IP_RATE_LIMIT_PER_MINUTE`, default 1200) and per signed-in account (`USER_RATE_LIMIT_PER_MINUTE`,
  default 300), and 500 users from one machine with a few tokens exceed both within seconds, which
  would turn the test into a measurement of the throttle. Set both to something like 100000 in
  staging's `.env`, redeploy, run, then put them back. Never weaken them on production.
- Run it from a machine whose network does not become the bottleneck, and note where it ran.
- Keep the printed summary. It goes into [launch-gates.md](launch-gates.md).
