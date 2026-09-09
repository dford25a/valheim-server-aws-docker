/**
 * Registers the /valheim slash command with Discord.
 *
 * Run once after creating the Discord application, and again any time the command
 * shape below changes:
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register-commands
 *
 * Set DISCORD_GUILD_ID as well to register against a single server. Guild commands
 * appear instantly, whereas global commands can take up to an hour to propagate.
 */

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must both be set.');
  process.exit(1);
}

// type 1 = SUB_COMMAND
const command = {
  name: 'valheim',
  description: 'Start, stop or check the Valheim server',
  options: [
    { name: 'start', description: 'Start the Valheim server', type: 1 },
    { name: 'stop', description: 'Stop the Valheim server', type: 1 },
    { name: 'status', description: 'Check whether the Valheim server is up', type: 1 },
  ],
};

const url = guildId
  ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const main = async () => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  const body = await res.text();

  if (!res.ok) {
    console.error(`Discord rejected the command (${res.status}):`, body);
    process.exit(1);
  }

  console.log(`Registered /valheim ${guildId ? `in guild ${guildId}` : 'globally'}.`);
  console.log(body);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
