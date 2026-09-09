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
    // Instance type. Valheim is RAM hungry once a world grows;
    // m6a.large (2 vCPU / 8 GB) comfortably handles ~10 players.
    instanceType: 'm6a.large',
    // Minutes with no players connected before the box shuts itself down
    idleShutdownMinutes: 30,

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
