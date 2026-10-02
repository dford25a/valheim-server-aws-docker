#!/bin/bash
set -euo pipefail

# Arguments passed in from the CDK stack's user data:
#  1: S3 bucket for world saves and backups
#  2: server name shown in the browser
#  3: world (save file) name
#  4: true|false - enable crossplay / join codes
#  5: true|false - list the server publicly
#  6: idle minutes before auto shutdown
#  7: SSM parameter name holding the server password
#  8: SSM parameter name holding the Discord webhook URL
#  9: AWS region
# 10: vanilla world modifiers, comma separated "name=value" (optional)
S3_BUCKET=$1
SERVER_NAME=$2
WORLD_NAME=$3
CROSSPLAY=${4:-true}
IS_PUBLIC=${5:-true}
IDLE_MINUTES=${6:-30}
PASSWORD_PARAM=$7
WEBHOOK_PARAM=$8
REGION=$9
WORLD_MODIFIERS=${10:-}

VALHEIM_DIR=/opt/valheim
AWS=/usr/local/bin/aws

##########################################
# Docker
##########################################

apt-get update
apt-get install -y curl ca-certificates cron

# Installs the engine plus the v2 compose plugin, so `docker compose` works
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

##########################################
# Secrets
##########################################

# WithDecryption is what turns the SecureString back into plaintext; the instance
# role is scoped to just these three parameters.
SERVER_PASSWORD=$($AWS ssm get-parameter --name "$PASSWORD_PARAM" --with-decryption \
    --region "$REGION" --query Parameter.Value --output text)
DISCORD_WEBHOOK=$($AWS ssm get-parameter --name "$WEBHOOK_PARAM" --with-decryption \
    --region "$REGION" --query Parameter.Value --output text)

##########################################
# Restore the world from S3
##########################################

mkdir -p "$VALHEIM_DIR"/valheim/saves "$VALHEIM_DIR"/valheim/server "$VALHEIM_DIR"/valheim/backups

# Pull the world down before the container starts, otherwise Valheim generates a
# fresh one and the old save is overwritten on the next backup cycle.
# player.list is odin's live record of who is online. Restoring an old copy would
# boot the server with phantom players, and the idle shutdown would never fire.
$AWS s3 sync "s3://$S3_BUCKET/valheim/saves" "$VALHEIM_DIR/valheim/saves" --region "$REGION" --exclude "player.list"
$AWS s3 sync "s3://$S3_BUCKET/valheim/backups" "$VALHEIM_DIR/valheim/backups" --region "$REGION"

# The image runs as uid 1000 inside the container and needs to own the volumes
chown -R 1000:1000 "$VALHEIM_DIR/valheim"

##########################################
# Compose file
##########################################

# This image does NOT take crossplay as a raw server argument. Passing
# SERVER_ARGS=-crossplay looks like it works but odin ignores it and logs
# "With Crossplay: 0", leaving console players unable to get a join code.
# ENABLE_CROSSPLAY is the variable it actually reads, and it defaults to 0.
CROSSPLAY_FLAG=0
if [ "$CROSSPLAY" = "true" ]; then
    CROSSPLAY_FLAG=1
fi

PUBLIC_FLAG=0
if [ "$IS_PUBLIC" = "true" ]; then
    PUBLIC_FLAG=1
fi

cat > "$VALHEIM_DIR/docker-compose.yml" << COMPOSE
services:
  valheim:
    image: mbround18/valheim:latest
    container_name: valheim
    restart: unless-stopped
    stop_grace_period: 2m
    # Valheim can spew stack traces in a tight loop (its external-IP lookup throws
    # on every retry when the host has no IPv6), which grew the log to 138 MB on a
    # single boot. Unbounded json-file logging would eventually fill the volume.
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"
    ports:
      - 2456:2456/udp
      - 2457:2457/udp
      - 2458:2458/udp
    environment:
      - PORT=2456
      - NAME=${SERVER_NAME}
      - WORLD=${WORLD_NAME}
      - PASSWORD=${SERVER_PASSWORD}
      - PUBLIC=${PUBLIC_FLAG}
      - ENABLE_CROSSPLAY=${CROSSPLAY_FLAG}
      # odin reads MODIFIERS as comma separated name=value and turns each into a
      # -modifier flag. Note this is NOT SERVER_ARGS: that variable exists but odin
      # does not feed it to the server binary, which is why -crossplay silently did
      # nothing when it was passed that way.
      - MODIFIERS=${WORLD_MODIFIERS}
      - TZ=UTC
      - AUTO_UPDATE=1
      - AUTO_UPDATE_SCHEDULE=0 1 * * *
      - AUTO_BACKUP=1
      - AUTO_BACKUP_SCHEDULE=*/30 * * * *
      - AUTO_BACKUP_ON_SHUTDOWN=1
      - AUTO_BACKUP_REMOVE_OLD=1
      - AUTO_BACKUP_DAYS_TO_LIVE=7
      - WEBHOOK_URL=${DISCORD_WEBHOOK}
    volumes:
      - ./valheim/saves:/home/steam/.config/unity3d/IronGate/Valheim
      - ./valheim/server:/home/steam/valheim
      - ./valheim/backups:/home/steam/backups
COMPOSE

# The compose file contains the server password in plaintext
chmod 600 "$VALHEIM_DIR/docker-compose.yml"

##########################################
# Backup helper
##########################################

cat > "$VALHEIM_DIR/backup.sh" << BACKUP
#!/bin/bash
$AWS s3 sync "$VALHEIM_DIR/valheim/saves" "s3://$S3_BUCKET/valheim/saves" --region "$REGION" --exclude "player.list"
$AWS s3 sync "$VALHEIM_DIR/valheim/backups" "s3://$S3_BUCKET/valheim/backups" --region "$REGION"
BACKUP
chmod +x "$VALHEIM_DIR/backup.sh"

##########################################
# Status heartbeat
##########################################

# The control lambda cannot see inside the box, and probing the Steam query port
# does not work: with crossplay the server registers through PlayFab and never
# opens a Steam query server, so A2S always times out even on a healthy world.
# Instead the server publishes what it knows to S3 once a minute, which also
# surfaces the join code — that rotates on every restart and is otherwise only
# discoverable by reading container logs.
cat > "$VALHEIM_DIR/heartbeat.sh" << 'HEARTBEAT'
#!/bin/bash
BUCKET="__BUCKET__"
REGION="__REGION__"
AWS=/usr/local/bin/aws

health=$(docker inspect valheim --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)

# Read the container's whole log, not a recent window. The join code, version and
# session registration are logged ONCE at startup, so a `--since 15m` window loses
# them a quarter of an hour into a session and the server reads as "starting up"
# while it is healthy and serving. The container is recreated on every start, so
# its log only ever covers the current run and cannot surface a stale join code;
# the json-file rotation in the compose file keeps it bounded.
logs=$(docker logs valheim 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')

joinCode=$(echo "$logs" | grep -oE 'join code [0-9]+' | tail -1 | grep -oE '[0-9]+')
version=$(echo "$logs" | grep -oE 'Valheim version: [^ ]+' | tail -1 | awk '{print $3}')

# Count and names come from odin's player.list via the same helper the idle
# shutdown uses. Valheim's own "now N player(s)" lines cannot be used: a leave is
# logged as "connection lost ... now 1 player(s)" with the count not decremented,
# so the last one stays high after everyone has gone.
players=$(__VALHEIM_DIR__/players.sh)
names=$(python3 -c 'import json,sys; print(", ".join(p.get("name","?") for p in json.load(open(sys.argv[1])).get("players", [])))' \
    __VALHEIM_DIR__/valheim/saves/player.list 2>/dev/null)

# Ready needs both. The join code proves this run loaded the world and registered
# a session; the health check proves it is still alive now. A join code from earlier
# in the run says nothing about whether the server has since wedged, and the image's
# health check is not documented as waiting for the world to load.
ready=false
if [ -n "$joinCode" ] && [ "$health" = "healthy" ]; then ready=true; fi

cat > /tmp/status.json << JSON
{
  "ready": $ready,
  "joinCode": "${joinCode:-unknown}",
  "players": ${players:-0},
  "names": "${names}",
  "version": "${version:-unknown}",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

$AWS s3 cp /tmp/status.json "s3://$BUCKET/status.json" --region "$REGION" --quiet
HEARTBEAT

sed -i "s|__BUCKET__|$S3_BUCKET|; s|__REGION__|$REGION|; s|__VALHEIM_DIR__|$VALHEIM_DIR|g" "$VALHEIM_DIR/heartbeat.sh"
chmod +x "$VALHEIM_DIR/heartbeat.sh"

##########################################
# Valheim service
##########################################

cat > /etc/systemd/system/valheim.service << SERVICE
[Unit]
Description=Valheim dedicated server (docker compose)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$VALHEIM_DIR
# Nobody can be online on a server that is only now starting. Clearing odin's
# player list covers the case S3 exclusion does not: a list left on this box's own
# disk when it went down with players connected (a /valheim stop mid-session).
ExecStartPre=/bin/rm -f $VALHEIM_DIR/valheim/saves/player.list
ExecStart=/usr/bin/docker compose up -d
# Bring the container down first so it flushes the world to disk, then ship it to S3.
# TimeoutStopSec has to clear the container's own 2 minute grace period.
ExecStop=/usr/bin/docker compose down
ExecStopPost=$VALHEIM_DIR/backup.sh
TimeoutStopSec=300

[Install]
WantedBy=multi-user.target
SERVICE

systemctl enable --now valheim

##########################################
# Idle auto shutdown
##########################################

# The Valheim server logs a "Connections N ZDOS:..." heartbeat every ~30s, which is
# a far more reliable player count than watching UDP sockets through Docker's NAT.
# Single source of truth for "who is online", shared by the idle shutdown and the
# status heartbeat so the two can never disagree.
#
# odin (the image's supervisor) maintains player.list itself, rewriting it
# atomically on every join and leave. It derives those from game-level events
# ("Got character ZDOID from <name>" / "Destroying abandoned non persistent zdo
# ... owner <peer>"), so it covers crossplay players arriving through PlayFab.
#
# The previous approach parsed Valheim's "Connections N" log line, on the belief
# that it was a ~30 second heartbeat. It is not: one appeared in twenty minutes of
# a live session. That starved the idle timer, which mostly skipped checks for
# want of data, and one stale "Connections 1" held it for ten minutes after the
# player had gone.
#
# Prints the player count, or nothing when it cannot be known yet.
cat > "$VALHEIM_DIR/players.sh" << 'PLAYERS'
#!/bin/bash
LIST=__VALHEIM_DIR__/valheim/saves/player.list

# Before this run has registered a session the game is still installing or
# loading, so "nobody online" would be meaningless rather than true.
docker logs valheim 2>&1 | grep -q -m1 'registered with join code' || exit 0

# odin writes the file on the first join or leave. Absent after the session is up
# means nobody has joined this run, which genuinely is zero players.
[ -f "$LIST" ] || { echo 0; exit 0; }

# On a parse failure print nothing, so callers treat it as unknown. Reporting 0
# instead could shut the server down with people on it.
python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("players", [])))' "$LIST" 2>/dev/null
PLAYERS

sed -i "s|__VALHEIM_DIR__|$VALHEIM_DIR|" "$VALHEIM_DIR/players.sh"
chmod +x "$VALHEIM_DIR/players.sh"

cat > "$VALHEIM_DIR/auto-shutdown.sh" << 'SHUTDOWN'
#!/bin/bash
IDLE_MINUTES=__IDLE_MINUTES__
CHECK_INTERVAL=60

idleChecks=0
requiredChecks=$((IDLE_MINUTES * 60 / CHECK_INTERVAL))

# Give the server time to install and come up before counting it as idle
sleep 600

while true; do
    sleep $CHECK_INTERVAL

    players=$(__VALHEIM_DIR__/players.sh)

    if [ -z "$players" ]; then
        # The game is still starting or the player list is unreadable. Do not
        # count it as an idle minute, or a slow install would shut itself down.
        echo "Player count not available yet, skipping this check."
        continue
    fi

    if [ "$players" -gt 0 ]; then
        if [ $idleChecks -gt 0 ]; then
            echo "$players player(s) online, resetting the idle timer."
        fi
        idleChecks=0
    else
        idleChecks=$((idleChecks + 1))
        echo "No players online ($idleChecks/$requiredChecks checks before shutdown)."
    fi

    if [ $idleChecks -ge $requiredChecks ]; then
        echo "Idle for $IDLE_MINUTES minutes, powering off."
        # Power off directly and let systemd stop valheim.service in dependency
        # order, which runs its ExecStop (docker compose down) and ExecStopPost
        # (S3 backup). Calling `systemctl stop valheim` here instead would trip
        # this unit's own ordering dependency and kill this script mid-line,
        # leaving the game down but the instance billing.
        shutdown -h now
        exit 0
    fi
done
SHUTDOWN

sed -i "s/__IDLE_MINUTES__/$IDLE_MINUTES/; s|__VALHEIM_DIR__|$VALHEIM_DIR|" "$VALHEIM_DIR/auto-shutdown.sh"
chmod +x "$VALHEIM_DIR/auto-shutdown.sh"

cat > /etc/systemd/system/valheim-auto-shutdown.service << SHUTDOWNSVC
[Unit]
Description=Shut the box down when nobody is playing Valheim
After=valheim.service
# Deliberately Wants= and not Requires=. Requires= propagates stops, so stopping
# valheim.service would also kill this watchdog.
Wants=valheim.service

[Service]
ExecStart=$VALHEIM_DIR/auto-shutdown.sh
Restart=on-failure
StandardOutput=journal
WorkingDirectory=$VALHEIM_DIR

[Install]
WantedBy=multi-user.target
SHUTDOWNSVC

systemctl enable --now valheim-auto-shutdown

##########################################
# Periodic backups
##########################################

# Belt and braces alongside the container's own 30 minute backup: this also
# captures the live save, not just the archived backups.
# `crontab -l` exits 1 when the user has no crontab yet, which under `set -e` would
# kill the subshell before the echo and take the whole install with it.
(crontab -l 2>/dev/null || true; echo "*/5 * * * * $VALHEIM_DIR/backup.sh >> /var/log/valheim-backup.log 2>&1") | crontab -

# Status heartbeat, every minute so /valheim status is never badly stale
(crontab -l 2>/dev/null || true; echo "* * * * * $VALHEIM_DIR/heartbeat.sh >> /var/log/valheim-heartbeat.log 2>&1") | crontab -

echo "Valheim server install complete."
