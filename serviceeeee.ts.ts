import AWS, { EC2 } from 'aws-sdk';
import NodeCache from 'node-cache';
import { DateTime } from 'luxon';

const cache = new NodeCache({ stdTTL: 7200, checkperiod: 600 });
const refreshThreshold = 130 * 60; // 2 hours and 10 minutes in seconds

export async function getOrganizationAccountsAndAllowedRegions(region: string, accessKey: string, secretKey: string): Promise<Record<string, string[]>> {
  const cacheKey = `${region}-${accessKey}-${secretKey}`;
  const cacheData = cache.get<Record<string, string[]>>(cacheKey);

  if (cacheData) {
    // Check if the data should be refreshed
    const ttl = cache.getTtl(cacheKey);
    const now = Date.now();
    if (ttl && (ttl - now) < (refreshThreshold * 1000)) {
      // Trigger background refresh
      refreshCache(cacheKey, region, accessKey, secretKey);
    }
    return cacheData;
  }

  // If cache is empty, fetch the data
  const freshData = await fetchDataAndCache(cacheKey, region, accessKey, secretKey);
  return freshData;
}

async function fetchDataAndCache(cacheKey: string, region: string, accessKey: string, secretKey: string): Promise<Record<string, string[]>> {
  try {
    const organizations = new AWS.Organizations({
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      region: region
    });

    let accountIds: string[];
    try {
      const response = await organizations.listAccounts().promise();
      if (!response.Accounts || response.Accounts.length === 0) {
        throw new Error('No AWS accounts found in the organization.');
      }
      accountIds = response.Accounts.map(account => account.Id);
    } catch (error) {
      if (error.code === 'AccessDeniedException' || error.code === 'UnauthorizedOperation') {
        // Assuming the credentials are for a child account
        console.log("Credentials likely for a child account. Proceeding with single account regions fetch.");
        const singleAccountId = await getSingleAccountId(accessKey, secretKey);
        const singleAccountRegions = await fetchRegionsForSingleAccount(singleAccountId, region, accessKey, secretKey);
        cache.set(cacheKey, singleAccountRegions, 7200); // 2 hours TTL
        return singleAccountRegions;
      } else {
        throw error;
      }
    }

    const accountsAndRegions: Record<string, string[]> = await fetchRegionsForAccounts(accountIds, region, accessKey, secretKey);
    // Store the result in cache
    cache.set(cacheKey, accountsAndRegions, 7200); // 2 hours TTL
    return accountsAndRegions;
  } catch (error) {
    console.error('Error fetching organization accounts and allowed regions:', error);
    throw new Error('Failed to fetch organization accounts and allowed regions. Please try again later.');
  }
}

async function getSingleAccountId(accessKey: string, secretKey: string): Promise<string> {
  const sts = new AWS.STS({
    accessKeyId: accessKey,
    secretAccessKey: secretKey
  });

  const identity = await sts.getCallerIdentity().promise();
  return identity.Account;
}

async function fetchRegionsForAccounts(accountIds: string[], region: string, accessKey: string, secretKey: string): Promise<Record<string, string[]>> {
  const accountsAndRegions: Record<string, string[]> = {};

  await Promise.all(accountIds.map(async (accountId) => {
    try {
      const { AccessKeyId, SecretAccessKey, SessionToken } = await assumeRoleAndCreateSTS(accessKey, secretKey, accountId);
      const awsConfig: AWS.ConfigurationOptions = {
        accessKeyId: AccessKeyId,
        secretAccessKey: SecretAccessKey,
        sessionToken: SessionToken
      };

      const ec2 = new AWS.EC2({ region, ...awsConfig });
      const regionsData = await ec2.describeRegions().promise();
      const regionNames = regionsData.Regions?.map(region => region.RegionName) || [];

      accountsAndRegions[accountId] = regionNames;
    } catch (error) {
      if (error.code === 'AccessDeniedException') {
        accountsAndRegions[accountId] = [`Access denied. You do not have sufficient permissions to get regions in account ${accountId}.`];
      }
    }
  }));

  return accountsAndRegions;
}

async function fetchRegionsForSingleAccount(accountId: string, region: string, accessKey: string, secretKey: string): Promise<Record<string, string[]>> {
  const accountsAndRegions: Record<string, string[]> = {};

  try {
    const ec2 = new AWS.EC2({
      region: region,
      accessKeyId: accessKey,
      secretAccessKey: secretKey
    });

    const regionsData = await ec2.describeRegions().promise();
    const regionNames = regionsData.Regions?.map(region => region.RegionName) || [];
    accountsAndRegions[accountId] = regionNames;
  } catch (error) {
    if (error.code === 'AccessDeniedException') {
      accountsAndRegions[accountId] = [`Access denied. You do not have sufficient permissions to get regions in account ${accountId}.`];
    } else {
      throw error;
    }
  }

  return accountsAndRegions;
}

function refreshCache(cacheKey: string, region: string, accessKey: string, secretKey: string): void {
  setTimeout(async () => {
    try {
      const freshData = await fetchDataAndCache(cacheKey, region, accessKey, secretKey);
      cache.set(cacheKey, freshData, 7200); // Refresh the cache
    } catch (error) {
      console.error('Error refreshing cache:', error);
    }
  }, 0); // Immediately invoke in the next event loop tick
}

// S3 storage pricing per GB per month
const S3_STORAGE_PRICE_PER_GB = 0.023; // Adjust this based on your AWS region and storage class

export async function getS3ObjectsCost(bucketName: string, credentials: { accessKeyId: string, secretAccessKey: string, sessionToken: string }): Promise<any> {
  AWS.config.update(credentials);
  const s3 = new AWS.S3();
  const storageClassCount: Record<string, number> = {};
  let totalSize = 0;

  const response = await s3.listObjectsV2({ Bucket: bucketName }).promise();
  if (response.Contents) {
    for (const obj of response.Contents) {
      const lastAccessed = obj.LastModified;
      if (lastAccessed) {
        const lastAccessedDate = DateTime.fromJSDate(lastAccessed);
        if (DateTime.now().diff(lastAccessedDate, 'days').days > 90) {
          totalSize += obj.Size || 0;
        }
        totalSize += obj.Size || 0;

        if (obj.StorageClass) {
          storageClassCount[obj.StorageClass] = (storageClassCount[obj.StorageClass] || 0) + 1;
        }
      }
    }
  }

  const totalSizeGB = totalSize / (1024 ** 3);
  const totalCost = totalSizeGB * S3_STORAGE_PRICE_PER_GB;
  const keys = Object.keys(storageClassCount);

  return {
    cost: Number(totalCost.toFixed(2)),
    potentialCostSaving: Number((totalCost - totalSizeGB * 0.00099).toFixed(2)),
    size: totalSizeGB,
    storageClass: keys[0],
  };
}

export async function getS3BucketInfo(accountId: string, access_key: string, secret_key: string, regions: string[]): Promise<any> {
  const credentials = {
    accessKeyId: access_key,
    secretAccessKey: secret_key,
  };

  const sts = new AWS.STS({ credentials });
  const roleArn = `arn:aws:iam::${accountId}:role/backstage-role-to-assume`;
  const result: any = {};

  await Promise.all(regions.map(async (region) => {
    try {
      const assumeRoleParams = {
        RoleArn: roleArn,
        RoleSessionName: 'AssumedRoleSession',
      };
      const assumeRoleResponse = await sts.assumeRole(assumeRoleParams).promise();
      const { AccessKeyId, SecretAccessKey, SessionToken } = assumeRoleResponse.Credentials;

      const assumedCredentials = {
        accessKeyId: AccessKeyId,
        secretAccessKey: SecretAccessKey,
        sessionToken: SessionToken,
      };

      const s3 = new AWS.S3({ region, credentials: assumedCredentials });

      try {
        const allBuckets = await s3.listBuckets().promise();
        const buckets = allBuckets.Buckets?.map((bucket) => bucket.Name) || [];

        await Promise.all(buckets.map(async (bucketName) => {
          try {
            const bucketInfo = await getS3ObjectsCost(bucketName as string, assumedCredentials);
            result[bucketName as string] = bucketInfo;
          } catch (error) {
            // console.error(`Error occurred while fetching S3 bucket info for bucket ${bucketName} in region ${region}:`, error);
          }
        }));
      } catch (error) {
        // console.error(`Error occurred while listing buckets in region ${region}:`, error);
      }
    } catch (error) {
      // console.error('Error occurred while assuming role:', error);
    }
  }));

  return result;
}

interface NetworkInterfaceInfo {
  accountId: string;
  region: string;
  networkInterfaceId: string;
  status: string;
  publicIp: string;
  cost: number;
}

export async function fetchUnattachedNetworkInterfaces(region: string, access_key: string, secret_key: string, accountid: string): Promise<NetworkInterfaceInfo[]> {
  try {
    // Fetch temporary credentials by assuming the role
    const { AccessKeyId, SecretAccessKey, SessionToken } = await assumeRoleAndCreateSTS(access_key, secret_key, accountid);

    // Configure AWS SDK with temporary credentials
    const credentials = {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: SessionToken
    };

    const ec2 = new EC2({ region, credentials });

    // Describe instances to get attached network interfaces
    const instancesData: EC2.DescribeInstancesResult = await ec2.describeInstances().promise();
    const attachedInterfaces: string[] = [];
    if (instancesData.Reservations) {
      for (const reservation of instancesData.Reservations) {
        for (const instance of reservation.Instances || []) {
          for (const networkInterface of instance.NetworkInterfaces || []) {
            attachedInterfaces.push(networkInterface.NetworkInterfaceId || '');
          }
        }
      }
    }

    // Describe network interfaces
    const networkInterfacesData: EC2.DescribeNetworkInterfacesResult = await ec2.describeNetworkInterfaces().promise();
    const networkInterfaces = networkInterfacesData.NetworkInterfaces || [];

    const unattachedInterfaces = networkInterfaces.filter(networkInterface => {
      return networkInterface.Status === "available" && !attachedInterfaces.includes(networkInterface.NetworkInterfaceId || '');
    });

    const result: NetworkInterfaceInfo[] = [];

    for (const networkInterface of unattachedInterfaces) {
      try {
        const publicIp = networkInterface.Association ? networkInterface.Association.PublicIp : null;
        const interfaceCost = calculateInterfaceCost(networkInterface);
        if (interfaceCost !== 0) {
          result.push({
            accountId: accountid,
            region,
            networkInterfaceId: networkInterface.NetworkInterfaceId || 'NA',
            status: networkInterface.Status || 'NA',
            publicIp: publicIp || 'NA',
            cost: interfaceCost
          });
        }
      } catch (error) {
        if (error.code === "AccessDenied") {
          // Access denied, continue to next iteration
          continue;
        } else {
          continue;
        }
      }
    }

    return result;
  } catch (error) {
    return []; // Return empty array to indicate failure for this region
  }
}


// Function to calculate the cost of a network interface
function calculateInterfaceCost(networkInterface: EC2.NetworkInterface): number {
  const publicIp = networkInterface.Association ? networkInterface.Association.PublicIp : null;

  if (publicIp) {
    const hourlyCostPerIp = 0.005;
    const numPublicIps = 1;
    const totalMonthlyCost = numPublicIps * hourlyCostPerIp * 24 * 30; // Total monthly cost

    // Return the cost rounded to 2 decimal places
    return Number(totalMonthlyCost.toFixed(2));
  } else {
    return 0; // No cost if no public IP associated
  }
}

interface Volume {
  VolumeId: string;
  Size: number;
  VolumeType: string;
  Iops?: number;
  Throughput?: number;
  Attachments?: any[]; // Assuming Attachments can be an array of any type
}

interface RegionVolumeCost {
  [volumeType: string]: {
    storageCost?: number;
    iopsFree?: number;
    iopsCostOver3000?: number;
    throughputFreeMBps?: number;
    throughputCostOver125?: number;
    costPerGB?: number;
    costPerIOPS?: { limit: number; cost: number }[] | number;
  } | number;
}

const regionVolumeCosts: { [region: string]: RegionVolumeCost } = {
  'us-east-1': {
    'gp3': {
      storageCost: 0.08,
      iopsFree: 3000,
      iopsCostOver3000: 0.005,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.04
    },
    'gp2': 0.10,
    'io2': {
      costPerGB: 0.125,
      costPerIOPS: [
        { limit: 32000, cost: 0.065 },
        { limit: 64000, cost: 0.046 },
        { limit: Infinity, cost: 0.032 }
      ]
    },
    'io1': {
      costPerGB: 0.125,
      costPerIOPS: 0.065
    },
    'st1': 0.045,
    'sc1': 0.015
  },
  'us-east-2': {
    'gp3': {
      storageCost: 0.08,
      iopsFree: 3000,
      iopsCostOver3000: 0.005,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.04
    },
    'gp2': 0.10,
    'io2': {
      costPerGB: 0.125,
      costPerIOPS: [
        { limit: 32000, cost: 0.065 },
        { limit: 64000, cost: 0.046 },
        { limit: Infinity, cost: 0.032 }
      ]
    },
    'io1': {
      costPerGB: 0.125,
      costPerIOPS: 0.065
    },
    'st1': 0.045,
    'sc1': 0.015
  },
  'us-west-1': {
    'gp3': {
      storageCost: 0.096,
      iopsFree: 3000,
      iopsCostOver3000: 0.006,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.048
    },
    'gp2': 0.12,
    'io2': {
      costPerGB: 0.138,
      costPerIOPS: [
        { limit: 32000, cost: 0.072 },
        { limit: 64000, cost: 0.050 },
        { limit: Infinity, cost: 0.035 }
      ]
    },
    'io1': {
      costPerGB: 0.138,
      costPerIOPS: 0.072
    },
    'st1': 0.054,
    'sc1': 0.018
  },
  'us-west-2': {
    'gp3': {
      storageCost: 0.08,
      iopsFree: 3000,
      iopsCostOver3000: 0.005,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.040
    },
    'gp2': 0.10,
    'io2': {
      costPerGB: 0.125,
      costPerIOPS: [
        { limit: 32000, cost: 0.065 },
        { limit: 64000, cost: 0.046 },
        { limit: Infinity, cost: 0.032 }
      ]
    },
    'io1': {
      costPerGB: 0.125,
      costPerIOPS: 0.065
    },
    'st1': 0.045,
    'sc1': 0.015
  },
  'ap-south-1': {
    'gp3': {
      storageCost: 0.0912,
      iopsFree: 3000,
      iopsCostOver3000: 0.0057,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.046
    },
    'gp2': 0.114,
    'io2': {
      costPerGB: 0.131,
      costPerIOPS: [
        { limit: 32000, cost: 0.068 },
        { limit: 64000, cost: 0.048 },
        { limit: Infinity, cost: 0.033 }
      ]
    },
    'io1': {
      costPerGB: 0.131,
      costPerIOPS: 0.068
    },
    'st1': 0.051,
    'sc1': 0.0174
  },
  'ap-northeast-2': {
    'gp3': {
      storageCost: 0.0912,
      iopsFree: 3000,
      iopsCostOver3000: 0.0057,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.046
    },
    'gp2': 0.114,
    'io2': {
      costPerGB: 0.1278,
      costPerIOPS: [
        { limit: 32000, cost: 0.067 },
        { limit: 64000, cost: 0.047 },
        { limit: Infinity, cost: 0.033 }
      ]
    },
    'io1': {
      costPerGB: 0.1278,
      costPerIOPS: 0.0666
    },
    'st1': 0.051,
    'sc1': 0.0174
  },
  'ap-southeast-1': {
    'gp3': {
      storageCost: 0.096,
      iopsFree: 3000,
      iopsCostOver3000: 0.006,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.048
    },
    'gp2': 0.12,
    'io2': {
      costPerGB: 0.138,
      costPerIOPS: [
        { limit: 32000, cost: 0.072 },
        { limit: 64000, cost: 0.050 },
        { limit: Infinity, cost: 0.035 }
      ]
    },
    'io1': {
      costPerGB: 0.138,
      costPerIOPS: 0.072
    },
    'st1': 0.054,
    'sc1': 0.018
  },
  'ap-southeast-2': {
    'gp3': {
      storageCost: 0.096,
      iopsFree: 3000,
      iopsCostOver3000: 0.006,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.048
    },
    'gp2': 0.12,
    'io2': {
      costPerGB: 0.138,
      costPerIOPS: [
        { limit: 32000, cost: 0.072 },
        { limit: 64000, cost: 0.050 },
        { limit: Infinity, cost: 0.035 }
      ]
    },
    'io1': {
      costPerGB: 0.138,
      costPerIOPS: 0.072
    },
    'st1': 0.054,
    'sc1': 0.018
  },
  'ap-northeast-1': {
    'gp3': {
      storageCost: 0.096,
      iopsFree: 3000,
      iopsCostOver3000: 0.006,
      throughputFreeMBps: 125,
      throughputCostOver125: 0.048
    },
    'gp2': 0.12,
    'io2': {
      costPerGB: 0.142,
      costPerIOPS: [
        { limit: 32000, cost: 0.074 },
        { limit: 64000, cost: 0.052 },
        { limit: Infinity, cost: 0.036 }
      ]
    },
    'io1': {
      costPerGB: 0.142,
      costPerIOPS: 0.074
    },
    'st1': 0.054,
    'sc1': 0.018
  }
};

export async function fetchUnusedEbsVolumes(region: string, access_key: string, secret_key: string, accountid: string): Promise<any[]> {
  try {
    const { AccessKeyId, SecretAccessKey, SessionToken } = await assumeRoleAndCreateSTS(access_key, secret_key, accountid);

    const credentials = {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: SessionToken
    };

    const ec2 = new EC2({ region, credentials });

    const response = await ec2.describeVolumes({}).promise();
    const responseVolumes = response.Volumes || [];

    const unusedVolumes: Volume[] = responseVolumes.map((volume: any) => ({
      VolumeId: volume.VolumeId,
      Size: typeof volume.Size === 'number' ? volume.Size.toString() : volume.Size,
      VolumeType: volume.VolumeType,
      Iops: typeof volume.Iops === 'number' ? volume.Iops : 0,
      Throughput: typeof volume.Throughput === 'number' ? volume.Throughput : 0,
      Attachments: volume.Attachments || [],
    })).filter((volume: Volume) => !volume.Attachments || volume.Attachments.length === 0);

    if (unusedVolumes.length === 0) {
      console.log(`No unused volumes found in region ${region}.`);
      return [];
    }

    const unusedVolumesWithCost = unusedVolumes.map((volume: Volume) => ({
      accountId: accountid,
      region: region,
      VolumeId: volume.VolumeId,
      VolumeType: volume.VolumeType,
      size: volume.Size,
      cost: calculateVolumeCost(region, volume),
    }));

    return unusedVolumesWithCost;
  } catch (error) {
    if (error.code === "AccessDenied") {
      // Access denied, log and return empty array
      return [];
    } else {
      // console.error(`Error fetching unused volumes in region ${region}:`, error);
      return [];
    }
  }
}

function calculateVolumeCost(region: string, volume: Volume): number {
  const volumeCosts = regionVolumeCosts[region][volume.VolumeType];

  if (typeof volumeCosts === 'number') {
    return volume.Size * volumeCosts;
  } else {
    let storageCost = volumeCosts.storageCost || 0;
    if (volume.VolumeType === 'gp3') {
      let cost = volume.Size * storageCost;

      if (volume.Iops && volume.Iops > (volumeCosts.iopsFree || 0)) {
        const iopsOverage = volume.Iops - (volumeCosts.iopsFree || 0);
        cost += iopsOverage * (volumeCosts.iopsCostOver3000 || 0);
      }

      if (volume.Throughput && volume.Throughput > (volumeCosts.throughputFreeMBps || 0)) {
        const throughputOverage = volume.Throughput - (volumeCosts.throughputFreeMBps || 0);
        cost += throughputOverage * (volumeCosts.throughputCostOver125 || 0);
      }

      return cost;
    } else if (volume.VolumeType === 'io2') {
      let cost = volume.Size * (volumeCosts.costPerGB || 0);
      if (volume.Iops && Array.isArray(volumeCosts.costPerIOPS)) {
        for (const tier of volumeCosts.costPerIOPS) {
          if (volume.Iops <= tier.limit) {
            cost += volume.Iops * tier.cost;
            break;
          } else {
            cost += tier.limit * tier.cost;
            volume.Iops -= tier.limit;
          }
        }
      }

      return cost;
    } else if (volume.VolumeType === 'io1') {
      return volume.Size * (volumeCosts.costPerGB || 0) + (volume.Iops || 0) * ((typeof volumeCosts.costPerIOPS === 'number') ? volumeCosts.costPerIOPS : 0);
    } else {
      return volume.Size * storageCost;
    }
  }
}

export async function listSnapshotsWithCost(region: string, access_key: string, secret_key: string, accountid: string): Promise<any[]> {
  const snapshotDetails: any[] = [];

  try {
    // Fetch temporary credentials by assuming the role
    const { AccessKeyId, SecretAccessKey, SessionToken } = await assumeRoleAndCreateSTS(access_key, secret_key, accountid);

    // Configure AWS SDK with temporary credentials
    const credentials = {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: SessionToken
    };

    const ec2 = new EC2({ region, credentials });

    const snapshots = await ec2.describeSnapshots({ OwnerIds: [accountid] }).promise();
    const snapshotsList = snapshots.Snapshots;

    if (snapshotsList && snapshotsList.length > 0) {
      for (const snapshot of snapshotsList) {
        const storageCostPerGbPerMonth = 0.05; // Change this to the actual cost of snapshot storage
        const snapshotSizeGb = snapshot.VolumeSize!;
        const snapshotCost = snapshotSizeGb * storageCostPerGbPerMonth;

        // Assuming snapshot is moved to S3 Glacier after 7 days
        const archivalCost = snapshotSizeGb * 0.0125; // Change this to the actual cost of Archive storage per GB per month

        snapshotDetails.push({
          accountId: accountid,
          region: region,
          snapshotId: snapshot.SnapshotId,
          snapshotTime: snapshot.StartTime, // Snapshot time here
          totalSnapshotCostPerMonth: snapshotCost,
          totalCostSavingsDeleted: snapshotCost,
          totalCostSavingsArchived: Math.round((snapshotCost - archivalCost) * 100) / 100,
        });
      }
    }

  } catch (error) {
    if (error.code === "AccessDenied") {
      // Access denied, continue to the next iteration
    } else {
      // Other errors, continue to the next iteration
    }
  }

  return snapshotDetails;
}


export interface MetricData {
  [key: string]: AWS.CloudWatch.Datapoint[] | undefined;
}

export interface CostOptimizationResult {
  accountId: string;
  instanceId: string;
  totalCost: number;
  recommendations: string[];
  monthlySavings: number;
}

export async function getRDSInstanceInfo(region: string, access_key: string, secret_key: string, accountid: string): Promise<any[]> {
  try {
    const { AccessKeyId, SecretAccessKey, SessionToken } = await assumeRoleAndCreateSTS(access_key, secret_key, accountid);
    const credentials = { accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: SessionToken };
    const client = new AWS.RDS({ region, credentials });
    const instances = await client.describeDBInstances().promise();

    if (!instances.DBInstances || instances.DBInstances.length === 0) {
      throw new Error(`No RDS instances found for account ${accountid}`);
    }

    const instance = instances.DBInstances[0];
    const instanceId: string = instance?.DBInstanceIdentifier || '';
    const instanceType = instance.DBInstanceClass ?? '';
    const allocatedStorage = instance.AllocatedStorage ?? 0;
    const storageType = instance.StorageType ?? '';
    const provisionedIops = instance.Iops ?? 0;

    return [instanceId, instanceType, allocatedStorage, storageType, provisionedIops];
  } catch (error) {
    throw error;
  }
}

export async function getRDSMetrics(region: string, access_key: string, secret_key: string, accountid: string, instanceId: string): Promise<MetricData> {
  try {
    const { AccessKeyId, SecretAccessKey, SessionToken } = await assumeRoleAndCreateSTS(access_key, secret_key, accountid);
    const credentials = { accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: SessionToken };
    const client = new AWS.CloudWatch({ region, credentials });
    const metrics = ['CPUUtilization', 'FreeableMemory', 'ReadIOPS', 'WriteIOPS'];
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const promises = metrics.map(metricName => {
      const params: AWS.CloudWatch.GetMetricStatisticsInput = {
        Namespace: 'AWS/RDS',
        MetricName: metricName,
        Dimensions: [{ Name: 'DBInstanceIdentifier', Value: instanceId }],
        StartTime: startOfMonth,
        EndTime: now,
        Period: 3600,  // 1 hour
        Statistics: ['Average', 'Maximum']
      };
      return client.getMetricStatistics(params).promise().then(data => data.Datapoints);
    });

    const metricData = await Promise.all(promises);
    const result: MetricData = {};
    metrics.forEach((metric, index) => {
      result[metric] = metricData[index];
    });
    return result;
  } catch (error) {
    throw error;
  }
}

export async function getInstancePricing(instanceType: string): Promise<number> {
  const instancePricing: { [key: string]: number } = {
    'db.t3.micro': 0.034,
    'db.t3.small': 0.068,
    'db.t3.medium': 0.136,
    'db.t3.large': 0.272,
    'db.m5.large': 0.342,
    'db.m5.xlarge': 0.684,
    'db.m5.2xlarge': 1.368,
    'db.m5.4xlarge': 2.736,
    'db.r5.large': 0.48,
    'db.r5.xlarge': 0.96,
  };

  return instancePricing[instanceType] ?? 0.005; // Using a generic pricing if not found
}

export async function getCostOptimizationRecommendations(accountId: string, instanceId: string, metricData: MetricData, instanceType: string, storageType: string, allocatedStorage: number, provisionedIops: number): Promise<CostOptimizationResult> {
  try {
    const rdsInstanceHourlyCost: number = await getInstancePricing(instanceType);
    const rdsStorageCostPerGB: number = 0.090275;
    const rdsProvisionedIopsCost: number = 0.0779875;
    const daysInMonth: number = 30;

    const cpuUtilizationAvg = (metricData['CPUUtilization'] ?? []).reduce((sum, point) => sum + (point?.Average ?? 0), 0) / Math.max((metricData['CPUUtilization'] ?? []).length, 1);
    const memoryUtilizationAvg = ((metricData['FreeableMemory'] ?? []).reduce((sum, point) => sum + (point?.Average ?? 0), 0) / Math.max((metricData['FreeableMemory'] ?? []).length, 1)) / (1024 ** 3);
    const readIopsAvg = (metricData['ReadIOPS'] ?? []).reduce((sum, point) => sum + (point?.Average ?? 0), 0) / Math.max((metricData['ReadIOPS'] ?? []).length, 1);
    const writeIopsAvg = (metricData['WriteIOPS'] ?? []).reduce((sum, point) => sum + (point?.Average ?? 0), 0) / Math.max((metricData['WriteIOPS'] ?? []).length, 1);

    let totalInstanceCost = rdsInstanceHourlyCost * daysInMonth;
    let totalStorageCost = rdsStorageCostPerGB * allocatedStorage * daysInMonth;
    let totalIopsCost = provisionedIops * rdsProvisionedIopsCost * daysInMonth;

    let totalCost = Math.round((totalInstanceCost + totalStorageCost + totalIopsCost) * 100) / 100;
    const recommendations: string[] = [];
    const estimatedSavings: number[] = [];

    if (cpuUtilizationAvg < 10) {
      const nextLowerInstanceType = determineNextLowerInstanceType(instanceType);
      const nextLowerInstanceHourlyCost = await getInstancePricing(nextLowerInstanceType);

      if (nextLowerInstanceHourlyCost !== undefined) {
        const savings = (rdsInstanceHourlyCost - nextLowerInstanceHourlyCost) * daysInMonth;
        recommendations.push(`Consider downsizing the RDS instance to a smaller instance type.`);
        estimatedSavings.push(savings);
      }
    }

    if (memoryUtilizationAvg < 10) {
      const storageSavings = rdsStorageCostPerGB * allocatedStorage * daysInMonth;
      recommendations.push(`Evaluate storage requirements and consider reducing allocated storage size if feasible.`);
      estimatedSavings.push(storageSavings);
    }

    if (readIopsAvg < provisionedIops / 2) {
      const currentIopsCost = provisionedIops * rdsProvisionedIopsCost;
      const reducedIopsCost = (provisionedIops / 2) * rdsProvisionedIopsCost;
      const savings = (currentIopsCost - reducedIopsCost) * daysInMonth;
      recommendations.push(`Review provisioned IOPS requirements and adjust if average read IOPS are significantly lower than provisioned IOPS.`);
      estimatedSavings.push(savings);
    }

    if (writeIopsAvg < provisionedIops / 2) {
      const currentIopsCost = provisionedIops * rdsProvisionedIopsCost;
      const reducedIopsCost = (provisionedIops / 2) * rdsProvisionedIopsCost;
      const savings = (currentIopsCost - reducedIopsCost) * daysInMonth;
      recommendations.push(`Review provisioned IOPS requirements and adjust if average write IOPS are significantly lower than provisioned IOPS.`);
      estimatedSavings.push(savings);
    }

    const totalEstimatedSavings = estimatedSavings.reduce((sum, saving) => sum + saving, 0);
    const monthlySavings = totalCost - totalEstimatedSavings;

    return { accountId, instanceId, totalCost, recommendations, monthlySavings: Math.round(monthlySavings * 100) / 100 };
  } catch (error) {
    throw error;
  }
}

function determineNextLowerInstanceType(currentInstanceType: string): string {
  const instanceTypes = [
    'db.t3.micro', 'db.t3.small', 'db.t3.medium', 'db.t3.large',
    'db.m5.large', 'db.m5.xlarge', 'db.m5.2xlarge', 'db.m5.4xlarge',
    'db.r5.large', 'db.r5.xlarge'
  ];
  const currentIndex = instanceTypes.indexOf(currentInstanceType);

  if (currentIndex === -1 || currentIndex === 0) {
    return currentInstanceType;
  }

  return instanceTypes[currentIndex - 1];
}

function assumeRoleAndCreateSTS(access_key: string, secret_key: string, accountid: string): { AccessKeyId: any; SecretAccessKey: any; SessionToken: any; } | PromiseLike<{ AccessKeyId: any; SecretAccessKey: any; SessionToken: any; }> {
  throw new Error('Function not implemented.');
}
