export const Config = {
    //////////////////////////////////////////
    // Compulsory
    //////////////////////////////////////////

    // AWS region to host the server in
    region: 'us-east-1',
    // AWS account ID
    account: '',
    // Prefix for every resource in this stack
    prefix: 'ValheimHosting',

    //////////////////////////////////////////
    // Valheim server settings
    //////////////////////////////////////////

    // Name shown in the Valheim server browser
    serverName: 'Valheim',
    // World/save file name. Changing this starts a NEW world.
    worldName: 'Dedicated',
    // Join code / crossplay. Lets Xbox + Game Pass players join without your IP.
    crossplay: true,
    // List the server publicly in the in-game browser
    public: true,
    // Instance type. Valheim's simulation loop is effectively single-threaded, so
    // per-core speed matters far more than core count or RAM. m7a.large is the same
    // 2 vCPU / 8 GB shape as m6a.large on a materially faster Genoa core.
    instanceType: 'm7a.large',
    // Minutes with no players connected before the box shuts itself down
    idleShutdownMinutes: 30,
    // Vanilla world modifiers, comma separated "name=value". These are server-side,
    // so they apply to every player including console — no mods required.
    //   resources:    muchless | less | more | muchmore | most  (0.5x .. 3x)
    //   combat:       veryeasy | easy | hard | veryhard
    //   deathpenalty: casual | veryeasy | easy | hard | hardcore
    //   raids:        none | muchless | less | more | muchmore
    //   portals:      casual | hard | veryhard
    // Caution: `resources` scales ALL drops, not just ore.
    worldModifiers: 'resources=muchmore',

    //////////////////////////////////////////
    // SSM SecureString parameter names
    // Create these with scripts/put-secrets.sh — never commit the values.
    //////////////////////////////////////////

    // Valheim server password (min 5 chars, must NOT appear in serverName/worldName)
    serverPasswordParam: '/valheim/server-password',
    // Discord channel webhook URL the server posts status updates to
    discordWebhookParam: '/valheim/discord-webhook',
    // Discord application PUBLIC KEY, used to verify slash command signatures
    discordPublicKeyParam: '/valheim/discord-public-key',

    //////////////////////////////////////////
    // Optional
    //////////////////////////////////////////

    // Bucket for world saves + backups. Leave empty to create a new one.
    bucketName: '',
    // Leave empty to use the default VPC
    vpcId: '',
    // Leave blank for auto-placement
    subnetId: '',
    // Needed only if subnetId is set (i.e. us-east-1a)
    availabilityZone: ''
};
