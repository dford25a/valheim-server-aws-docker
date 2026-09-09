import { createPublicKey, verify as cryptoVerify, KeyObject } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const publicKeyParam = process.env.DISCORD_PUBLIC_KEY_PARAM!;
const controlFunction = process.env.SERVER_CONTROL_FUNCTION!;
const serverIp = process.env.SERVER_IP!;

const ssm = new SSMClient({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

// Discord interaction + response type numbers
// https://discord.com/developers/docs/interactions/receiving-and-responding
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;

let cachedKey: KeyObject | undefined;

/**
 * Discord hands out its public key as 32 raw hex bytes, but Node's crypto only
 * imports Ed25519 keys in SPKI DER form. Prefixing the standard Ed25519 SPKI
 * header turns the raw key into something createPublicKey accepts, which avoids
 * pulling in tweetnacl just for this.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const getPublicKey = async (): Promise<KeyObject> => {
  if (cachedKey) return cachedKey;
  const res = await ssm.send(
    new GetParameterCommand({ Name: publicKeyParam, WithDecryption: true })
  );
  const hex = res.Parameter?.Value;
  if (!hex) throw new Error(`Discord public key not found at ${publicKeyParam}`);

  cachedKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex.trim(), 'hex')]),
    format: 'der',
    type: 'spki',
  });
  return cachedKey;
};

const isValidSignature = async (event: APIGatewayProxyEvent): Promise<boolean> => {
  // API Gateway does not normalise header casing, so match case-insensitively
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  const body = event.body;

  if (!signature || !timestamp || !body) return false;

  try {
    return cryptoVerify(
      null,
      Buffer.from(timestamp + body),
      await getPublicKey(),
      Buffer.from(signature, 'hex')
    );
  } catch (err) {
    console.error('Signature verification threw', err);
    return false;
  }
};

const reply = (content: string): APIGatewayProxyResult => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: RESPONSE_CHANNEL_MESSAGE,
    data: { content },
  }),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Discord periodically re-verifies the endpoint and will disable it on a 2xx
  // for an unsigned request, so this check has to come before anything else.
  if (!(await isValidSignature(event))) {
    console.warn('Rejected request with invalid signature');
    return { statusCode: 401, body: 'invalid request signature' };
  }

  const interaction = JSON.parse(event.body!);

  if (interaction.type === INTERACTION_PING) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: RESPONSE_PONG }),
    };
  }

  if (interaction.type !== INTERACTION_APPLICATION_COMMAND) {
    return reply('Unsupported interaction type.');
  }

  // /valheim start -> options[0].name === 'start'
  const subCommand: string | undefined = interaction.data?.options?.[0]?.name;

  if (!subCommand || !['start', 'stop', 'status'].includes(subCommand)) {
    return reply('Unknown command. Try `/valheim start`, `/valheim stop` or `/valheim status`.');
  }

  // Fire and forget: Discord drops the interaction if we take longer than 3
  // seconds, and the control lambda posts the real outcome to the webhook.
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: controlFunction,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ action: subCommand })),
    })
  );

  const acks: Record<string, string> = {
    start: `Waking the Valheim server up. It will be joinable at \`${serverIp}:2456\` shortly.`,
    stop: 'Telling the Valheim server to save and shut down.',
    status: 'Checking on the Valheim server...',
  };

  return reply(acks[subCommand]);
};
