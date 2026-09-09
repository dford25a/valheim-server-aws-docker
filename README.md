# Valheim AWS Server

An on-demand Valheim dedicated server on AWS, controlled from Discord with `/valheim start`,
`/valheim stop` and `/valheim status`. The box shuts itself down when nobody is playing, so
you only pay for the hours you actually raid in.

Runs **Valheim 1.0** (`l-1.0.7`, network version 39), with crossplay enabled so Steam,
Xbox/Game Pass, PS5 and Switch 2 players can all join the same world.

## Lineage

This borrows from two earlier projects and modernises both:

- The CDK hosting pattern (EC2 + Elastic IP + S3 saves + idle shutdown + a restart API)
  comes from the [Satisfactory server hosting](https://github.com/dford25a/satisfactory-server-aws-docker) setup.
- The Discord slash command design comes from
  [samchungy/valheim-aws-spot-server](https://github.com/samchungy/valheim-aws-spot-server).

### What is different here

| | Upstream | Here |
|---|---|---|
| IaC | Serverless Framework | AWS CDK (TypeScript) |
| Base image | Amazon Linux 2, `amazon-linux-extras` | Ubuntu 22.04, `get.docker.com` |
| Compose | pinned `v2.0.0-rc.3`, `version: '3'` key | current compose plugin, no obsolete key |
| Discord auth | `tweetnacl` dependency | Node's native `crypto` Ed25519, zero deps |
| Idle shutdown | none (spot termination watcher only) | player-count aware, see below |
| Crossplay | not supported | `-crossplay` on by default |

### Idle detection

This is the one piece worth stealing. The obvious approach — and what the Satisfactory
version does — is to watch UDP sockets:

```sh
ss -lu | grep 777 | awk '{s+=$2} END {print s}'   # sums Recv-Q
```

That is unreliable in general and actively wrong behind Docker, where `docker-proxy`
owns the host socket and the real client traffic is NATed into the container. It also
infers "somebody is playing" from buffer bytes rather than from players.

Valheim logs its own player count every ~30 seconds:

```
Connections 2 ZDOS:12345 sent:...
```

So the shutdown timer reads that instead, which is the actual number the decision depends
on, and is independent of the networking layer entirely:

```sh
docker logs --since 2m valheim | grep -oE 'Connections [0-9]+' | tail -1 | grep -oE '[0-9]+'
```

An absent heartbeat is treated as "unknown", not "idle", so a slow first install or a
wedged server cannot shut itself down mid-setup. The same trick works for any game server
that logs a player count.

## Architecture

```
Discord  ──/valheim start──▶  API Gateway  ──▶  interactions λ  ──async──▶  server-control λ
                                                (verifies ed25519)              │
                                                                                ▼
                                                                        EC2 start/stop
                                                                                │
    Discord channel  ◀──webhook──  mbround18/valheim container  ◀──────────  EC2 + Elastic IP
                                          │
                                          ▼
                                    S3 (world + backups)
```

- **EC2 on-demand instance** (`m6a.large`, Ubuntu 22.04) with a **static Elastic IP**, so the
  address players save in their favourites survives every shutdown cycle.
- **Docker** running `mbround18/valheim`, which handles game updates, scheduled backups and
  its own Discord lifecycle notifications.
- **S3** holds the world save. It is restored on boot and synced back every 5 minutes, on
  container shutdown, and on instance stop.
- **Idle auto-shutdown** after 30 minutes with no players, read from the server's own
  `Connections N` log heartbeat.
- **Session Manager** for shell access, so there is no SSH key or open port 22.

## What you need before deploying

### 1. A Discord application

Create one at <https://discord.com/developers/applications>. From it you need:

| Value | Where to find it | Used for |
|---|---|---|
| **Public Key** | General Information page | Verifying that slash command requests really came from Discord |
| **Application ID** | General Information page | Registering the `/valheim` command |
| **Bot Token** | Bot page → Reset Token | Registering the `/valheim` command (only used locally, never deployed) |

Also invite the app to your server with the `applications.commands` scope
(OAuth2 → URL Generator).

### 2. A channel webhook

In Discord: **Server Settings → Integrations → Webhooks → New Webhook**, point it at the
channel you want status messages in, and copy the URL. This is what posts "server is up at
`x.x.x.x:2456`" and the container's start/stop notices.

### 3. A Valheim server password

Minimum 5 characters, and it must **not** appear as a substring of your server name or world
name — Valheim refuses to start if it does.

## Deploying

```bash
# 1. Configure
cp server-hosting/config.sample.ts server-hosting/config.ts
#    then edit account, region, serverName, worldName

# 2. Store the secrets in SSM (they never go in the repo or the template)
./scripts/put-secrets.sh us-east-1

# 3. Deploy
npm install
npx cdk deploy
```

The deploy prints the outputs you need:

```
ValheimHostingServerIp          = 1.2.3.4
ValheimHostingInteractionsUrl   = https://xxxx.execute-api.us-east-1.amazonaws.com/prod/interactions
ValheimHostingSavesBucketName   = valheimhostingstack-...
ValheimHostingServerControlFunction = ValheimHostingStack-ValheimHostingServerControl...
```

### 4. Wire up Discord

Paste the `InteractionsUrl` into your Discord application's **Interactions Endpoint URL**
field. Discord immediately sends a signed PING; if the field saves without an error, the
signature verification is working.

Then register the command:

```bash
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
  npm run register-commands
```

Passing `DISCORD_GUILD_ID` registers against one server and appears instantly. Leave it out
for a global command, which can take up to an hour to show up.

## Using it

| Command | Effect |
|---|---|
| `/valheim start` | Boots the instance. Joinable in ~3-5 minutes; the container posts to the webhook when it is actually ready. |
| `/valheim stop` | Saves the world, syncs to S3, powers the box down. |
| `/valheim status` | Reports whether the server is up and at which IP. |

Players join via **`<ElasticIP>:2456`**, or with the crossplay join code shown in the server
logs if they are on Game Pass / Xbox.

Without Discord, the same actions work from the CLI:

```bash
aws lambda invoke --function-name <ServerControlFunction> \
  --payload '{"action":"start"}' --cli-binary-format raw-in-base64-out /dev/stdout
```

## Operating

```bash
# Shell onto the box
aws ssm start-session --target <instance-id>

# On the box
sudo docker logs -f valheim          # server log
sudo systemctl status valheim        # service state
sudo /opt/valheim/backup.sh          # force a backup to S3
sudo journalctl -u valheim-auto-shutdown -f   # idle timer decisions
```

## Cost

Roughly `$0.086/hr` for the `m6a.large` while running, plus a few dollars a month for the
30 GB volume, S3 and the Elastic IP. At 15 hours of play a week that lands around
**$10-15/month**. The idle shutdown is what keeps it there — an instance left running
24/7 would be about $62/month.

## Notes

- **A `cdk deploy` that changes user data replaces the instance.** The world is safe (it
  lives in S3 and is restored on boot), but expect ~10 minutes of downtime while Docker and
  the game reinstall. The Elastic IP does not change.
- **Changing `worldName` starts a brand new world.** The old one stays in S3 under its own
  name, so switching back is just a config change and a restart.
- Secrets live in SSM as `SecureString` parameters, not in the repo or the CloudFormation
  template. `server-hosting/config.ts` is gitignored.
- **Game updates are decoupled from the image.** `mbround18/valheim` installs the server
  through steamcmd when the container starts, so the running game tracks Steam's current
  build regardless of how old the image is. Valheim 1.0 needed no changes here — unlike
  Satisfactory, whose 1.0 and 1.1 releases moved the management API to TCP 7777 and the
  join stream to TCP 8888. Valheim's UDP 2456-2458 layout has been stable throughout.

## Licence

MIT. See [LICENSE](LICENSE).
