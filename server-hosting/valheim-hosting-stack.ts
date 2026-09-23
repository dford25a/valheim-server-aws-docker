import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Config } from './config';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigateway';

export class ValheimHostingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const prefix = Config.prefix;

    //////////////////////////////////////////
    // Network and security
    //////////////////////////////////////////

    const lookUpOrDefaultVpc = (vpcId: string): ec2.IVpc =>
      vpcId
        ? ec2.Vpc.fromLookup(this, `${prefix}Vpc`, { vpcId })
        : ec2.Vpc.fromLookup(this, `${prefix}Vpc`, { isDefault: true });

    const publicOrLookupSubnet = (subnetId: string, availabilityZone: string): ec2.SubnetSelection =>
      subnetId && availabilityZone
        ? {
            subnets: [
              ec2.Subnet.fromSubnetAttributes(this, `${prefix}ServerSubnet`, {
                availabilityZone,
                subnetId,
              }),
            ],
          }
        : { subnetType: ec2.SubnetType.PUBLIC };

    const vpc = lookUpOrDefaultVpc(Config.vpcId);
    const vpcSubnets = publicOrLookupSubnet(Config.subnetId, Config.availabilityZone);

    const securityGroup = new ec2.SecurityGroup(this, `${prefix}ServerSecurityGroup`, {
      vpc,
      description: 'Allow Valheim clients to connect to the server',
    });

    // Valheim listens on a contiguous UDP block: the game port itself, the Steam
    // query port on +1, and +2 which the server also binds. Steam's server browser
    // will not list the world unless the query port is reachable.
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udpRange(2456, 2458),
      'Valheim game + query ports (UDP)'
    );

    //////////////////////////////////////////
    // Server instance
    //////////////////////////////////////////

    const server = new ec2.Instance(this, `${prefix}Server`, {
      instanceType: new ec2.InstanceType(Config.instanceType),
      // Canonical publishes an SSM parameter that always resolves to the current 22.04 AMI
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
      ),
      // Base OS ~5 GB, Valheim server ~3 GB, plus Docker images and rolling backups
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(30),
        },
      ],
      vpcSubnets,
      userDataCausesReplacement: true,
      vpc,
      securityGroup,
    });

    // Without a static address, every idle shutdown / restart cycle hands out a new
    // public IP and invalidates whatever players saved in their favourites list.
    const eip = new ec2.CfnEIP(this, `${prefix}ServerEip`, {
      domain: 'vpc',
      instanceId: server.instanceId,
    });

    // Session Manager access, so there is no SSH key or port 22 to manage
    server.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    //////////////////////////////////////////
    // World save bucket
    //////////////////////////////////////////

    const savesBucket = Config.bucketName
      ? s3.Bucket.fromBucketName(this, `${prefix}SavesBucket`, Config.bucketName)
      : new s3.Bucket(this, `${prefix}SavesBucket`);

    savesBucket.grantReadWrite(server.role);

    //////////////////////////////////////////
    // Secrets
    //////////////////////////////////////////

    // These are SecureString parameters, which CloudFormation cannot create, so they are
    // provisioned out of band by scripts/put-secrets.sh and only referenced here.
    const secretParamArns = [
      Config.serverPasswordParam,
      Config.discordWebhookParam,
      Config.discordPublicKeyParam,
    ].map((name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`);

    const readSecrets = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: secretParamArns,
    });

    // The instance pulls the server password and webhook at boot to build its compose file
    server.addToRolePolicy(readSecrets);

    //////////////////////////////////////////
    // Instance startup
    //////////////////////////////////////////

    server.userData.addCommands('sudo apt-get install unzip -y');
    server.userData.addCommands(
      'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && unzip awscliv2.zip && ./aws/install'
    );

    const startupScript = new s3_assets.Asset(this, `${prefix}InstallAsset`, {
      path: './server-hosting/scripts/install.sh',
    });
    startupScript.grantRead(server.role);

    const localPath = server.userData.addS3DownloadCommand({
      bucket: startupScript.bucket,
      bucketKey: startupScript.s3ObjectKey,
    });

    server.userData.addExecuteFileCommand({
      filePath: localPath,
      arguments: [
        savesBucket.bucketName,
        `"${Config.serverName}"`,
        `"${Config.worldName}"`,
        String(Config.crossplay),
        String(Config.public),
        String(Config.idleShutdownMinutes),
        Config.serverPasswordParam,
        Config.discordWebhookParam,
        this.region,
      ].join(' '),
    });

    //////////////////////////////////////////
    // Start / stop control plane
    //////////////////////////////////////////

    // Does the actual EC2 work. Split out from the Discord handler so it can also be
    // invoked straight from the CLI when Discord is down or you are debugging.
    const serverControlLambda = new lambda_nodejs.NodejsFunction(this, `${prefix}ServerControlLambda`, {
      entry: './server-hosting/lambda/server-control.ts',
      description: 'Start or stop the Valheim server',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      environment: {
        INSTANCE_ID: server.instanceId,
        SERVER_IP: eip.ref,
        DISCORD_WEBHOOK_PARAM: Config.discordWebhookParam,
        SAVES_BUCKET: savesBucket.bucketName,
      },
    });

    // Reads the status.json heartbeat the instance publishes
    savesBucket.grantRead(serverControlLambda);

    serverControlLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances'],
        resources: [`arn:aws:ec2:*:${this.account}:instance/${server.instanceId}`],
      })
    );
    // DescribeInstances does not support resource-level permissions
    serverControlLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      })
    );
    serverControlLambda.addToRolePolicy(readSecrets);

    // Discord's entry point. Verifies the request signature, then hands off.
    const interactionsLambda = new lambda_nodejs.NodejsFunction(this, `${prefix}InteractionsLambda`, {
      entry: './server-hosting/lambda/interactions.ts',
      description: 'Handle Discord slash commands for the Valheim server',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Discord hangs up on any interaction that takes longer than 3 seconds
      timeout: Duration.seconds(10),
      environment: {
        DISCORD_PUBLIC_KEY_PARAM: Config.discordPublicKeyParam,
        SERVER_CONTROL_FUNCTION: serverControlLambda.functionName,
        SERVER_IP: eip.ref,
      },
    });

    interactionsLambda.addToRolePolicy(readSecrets);
    serverControlLambda.grantInvoke(interactionsLambda);

    const api = new apigw.RestApi(this, `${prefix}Api`, {
      restApiName: `${prefix}Api`,
      description: 'Discord interaction endpoint for the Valheim server',
    });
    api.root
      .addResource('interactions')
      .addMethod('POST', new apigw.LambdaIntegration(interactionsLambda));

    //////////////////////////////////////////
    // Outputs
    //////////////////////////////////////////

    new CfnOutput(this, `${prefix}ServerIp`, {
      value: eip.ref,
      description: 'Static public IP of the Valheim server (join via <IP>:2456)',
    });

    new CfnOutput(this, `${prefix}InteractionsUrl`, {
      value: `${api.url}interactions`,
      description: 'Set this as the Interactions Endpoint URL in the Discord Developer Portal',
    });

    new CfnOutput(this, `${prefix}SavesBucketName`, {
      value: savesBucket.bucketName,
      description: 'S3 bucket holding world saves and backups',
    });

    new CfnOutput(this, `${prefix}ServerControlFunction`, {
      value: serverControlLambda.functionName,
      description: 'Invoke directly to start/stop without Discord',
    });
  }
}
