import NodeCache from 'node-cache';
import { getS3BucketInfo, getOrganizationAccountsAndAllowedRegions, fetchUnattachedNetworkInterfaces, fetchUnusedEbsVolumes, listSnapshotsWithCost, MetricData, CostOptimizationResult, getRDSInstanceInfo, getRDSMetrics, getCostOptimizationRecommendations } from './serviceeeee';

const cache = new NodeCache({ stdTTL: 7200, checkperiod: 600 }); // 2 hours TTL, 10 minutes check period
  const refreshThreshold = 130 * 60; // 2 hours and 10 minutes in seconds

  // Cache helper functions
  function getCacheData<T>(cacheKey: string): T | undefined {
    const cacheData = cache.get<T>(cacheKey);

    if (cacheData) {
      const ttl = cache.getTtl(cacheKey);
      const now = Date.now();
      if (ttl && (ttl - now) < (refreshThreshold * 1000)) {
        // Data is nearing expiration, trigger background refresh
        return cacheData;
      }
    }
    return undefined;
  }

  function setCacheData<T>(cacheKey: string, data: T): void {
    cache.set(cacheKey, data, 7200); // Cache for 2 hours
  }

  function refreshCache<T>(cacheKey: string, fetchData: () => Promise<T>): void {
    setTimeout(async () => {
      try {
        const freshData = await fetchData();
        setCacheData(cacheKey, freshData);
      } catch (error) {
        console.error(`Error refreshing cache for ${cacheKey}:`, error);
      }
    }, 0); // Immediately invoke in the next event loop tick
  }

  // S3 Route
  router.post('/s3', async (req, res) => {
    try {
      const awsCreds = await fetchCredentials(discoveryApi, configApi);
      const accessKey = awsCreds.data.access_key;
      const secretKey = awsCreds.data.secret_key;
      const region = "us-east-1"; // Specify the region here

      const organizationAccountsAndRegions = await getOrganizationAccountsAndAllowedRegions(region, accessKey, secretKey);

      if (!organizationAccountsAndRegions || Object.keys(organizationAccountsAndRegions).length === 0) {
        throw new Error('No organization accounts and regions found.');
      }

      const cacheKey = `s3-${region}-${accessKey}-${secretKey}`;
      const cacheData = getCacheData<any[]>(cacheKey);

      if (cacheData) {
        refreshCache(cacheKey, () => fetchS3DataAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey));
        return res.json(cacheData);
      }

      const results = await fetchS3DataAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey);
      return res.json(results);

    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch S3 bucket information' });
    }
  });

  async function fetchS3DataAndCache(cacheKey: string, organizationAccountsAndRegions: Record<string, string[]>, accessKey: string, secretKey: string): Promise<any[]> {
    const results: any[] = [];

    const fetchBucketInfoPromises = Object.keys(organizationAccountsAndRegions).map(async (accountId) => {
      const regions = organizationAccountsAndRegions[accountId];
      const bucketInfo = await getS3BucketInfo(accountId, accessKey, secretKey, regions);

      const filteredBucketInfo = Object.entries(bucketInfo)
        .reduce((acc, [bucketName, info]) => {
          if (info.cost !== 0) {
            acc[bucketName] = info;
          }
          return acc;
        }, {});

      results.push({ accountId, buckets: filteredBucketInfo });
    });

    await Promise.all(fetchBucketInfoPromises);

    setCacheData(cacheKey, results);

    return results;
  }

  // Unattached Interfaces Route
  router.post('/unattached-interfaces', async (req, res) => {
    try {
      const awsCreds = await fetchCredentials(discoveryApi, configApi);
      const accessKey = awsCreds.data.access_key;
      const secretKey = awsCreds.data.secret_key;
      const region = "us-east-1"; // Specify the region here

      const organizationAccountsAndRegions = await getOrganizationAccountsAndAllowedRegions(region, accessKey, secretKey);

      if (!organizationAccountsAndRegions || Object.keys(organizationAccountsAndRegions).length === 0) {
        throw new Error('No organization accounts and regions found.');
      }

      const cacheKey = `unattached-interfaces-${region}-${accessKey}-${secretKey}`;
      const cacheData = getCacheData<any[]>(cacheKey);

      if (cacheData) {
        refreshCache(cacheKey, () => fetchUnattachedInterfacesAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey));
        return res.json(cacheData);
      }

      const results = await fetchUnattachedInterfacesAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey);
      return res.json(results);

    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch unattached network interfaces' });
    }
  });

  async function fetchUnattachedInterfacesAndCache(cacheKey: string, organizationAccountsAndRegions: Record<string, string[]>, accessKey: string, secretKey: string): Promise<any[]> {
    const unattachedInterfacesPromises = Object.keys(organizationAccountsAndRegions).flatMap(accountId => {
      return organizationAccountsAndRegions[accountId].map(region => {
        return fetchUnattachedNetworkInterfaces(region, accessKey, secretKey, accountId);
      });
    });

    const unattachedInterfacesArray = await Promise.all(unattachedInterfacesPromises);
    const unattachedInterfaces = unattachedInterfacesArray.flat().filter(info => info.cost !== 0); // Filter out zero-cost interfaces

    setCacheData(cacheKey, unattachedInterfaces);

    return unattachedInterfaces;
  }

  // Unused Volumes Route
  router.post('/unusedvolumes', async (req, res) => {
    try {
      const awsCreds = await fetchCredentials(discoveryApi, configApi);
      const accessKey = awsCreds.data.access_key;
      const secretKey = awsCreds.data.secret_key;
      const region = "us-east-1"; // Specify the region here

      const organizationAccountsAndRegions = await getOrganizationAccountsAndAllowedRegions(region, accessKey, secretKey);

      if (!organizationAccountsAndRegions || Object.keys(organizationAccountsAndRegions).length === 0) {
        throw new Error('No organization accounts and regions found.');
      }

      const cacheKey = `unusedvolumes-${region}-${accessKey}-${secretKey}`;
      const cacheData = getCacheData<any[]>(cacheKey);

      if (cacheData) {
        refreshCache(cacheKey, () => fetchUnusedVolumesAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey));
        return res.json(cacheData);
      }

      const results = await fetchUnusedVolumesAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey);
      return res.json(results);

    } catch (error) {
      console.error("Error fetching unused volumes:", error);
      res.status(500).json({ error: 'Failed to fetch unused volumes' });
    }
  });

  async function fetchUnusedVolumesAndCache(cacheKey: string, organizationAccountsAndRegions: Record<string, string[]>, accessKey: string, secretKey: string): Promise<any[]> {
    const unusedVolumesPromises = Object.keys(organizationAccountsAndRegions).flatMap(accountId => {
      return organizationAccountsAndRegions[accountId].map(region => {
        return fetchUnusedEbsVolumes(region, accessKey, secretKey, accountId);
      });
    });

    const unusedVolumesArray = await Promise.all(unusedVolumesPromises);
    const unusedVolumes = unusedVolumesArray.flat(); // Flatten the array of arrays

    setCacheData(cacheKey, unusedVolumes);

    return unusedVolumes;
  }

  // EC2 Snapshots Route
  router.post('/ec2snapshots', async (req, res) => {
    try {
      const awsCreds = await fetchCredentials(discoveryApi, configApi);
      const accessKey = awsCreds.data.access_key;
      const secretKey = awsCreds.data.secret_key;
      const region = "us-east-1"; // Specify the region here

      const organizationAccountsAndRegions = await getOrganizationAccountsAndAllowedRegions(region, accessKey, secretKey);

      if (!organizationAccountsAndRegions || Object.keys(organizationAccountsAndRegions).length === 0) {
        throw new Error('No organization accounts and regions found.');
      }

      const cacheKey = `ec2snapshots-${region}-${accessKey}-${secretKey}`;
      const cacheData = getCacheData<any[]>(cacheKey);

      if (cacheData) {
        refreshCache(cacheKey, () => fetchSnapshotsAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey));
        return res.json(cacheData);
      }

      const results = await fetchSnapshotsAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey);
      return res.json(results);

    } catch (error) {
      console.error("Error fetching snapshot details:", error);
      res.status(500).json({ error: 'Failed to fetch snapshot details' });
    }
  });

  async function fetchSnapshotsAndCache(cacheKey: string, organizationAccountsAndRegions: Record<string, string[]>, accessKey: string, secretKey: string): Promise<any[]> {
    const snapshotDetailsPromises = Object.keys(organizationAccountsAndRegions).flatMap(accountId => {
      return organizationAccountsAndRegions[accountId].map(region => {
        return listSnapshotsWithCost(region, accessKey, secretKey, accountId);
      });
    });

    const snapshotDetailsArray = await Promise.all(snapshotDetailsPromises);
    const snapshotDetails = snapshotDetailsArray.flat(); // Flatten the array of arrays

    setCacheData(cacheKey, snapshotDetails);

    return snapshotDetails;
  }

  router.post('/rds-cost-optimization', async (req, res) => {
    try {
      const region = "us-east-1"; // Specify the default region here or fetch dynamically if needed
      const awsCreds = await fetchCredentials(discoveryApi, configApi);
      const accessKey = awsCreds.data.access_key;
      const secretKey = awsCreds.data.secret_key;
  
      const organizationAccountsAndRegions = await getOrganizationAccountsAndAllowedRegions(region, accessKey, secretKey);
  
      if (!organizationAccountsAndRegions || Object.keys(organizationAccountsAndRegions).length === 0) {
        throw new Error('No organization accounts and regions found.');
      }
  
      const cacheKey = `rds-cost-optimization-${region}-${accessKey}-${secretKey}`;
      const cacheData = getCacheData<CostOptimizationResult[]>(cacheKey);
  
      if (cacheData) {
        refreshCache(cacheKey, async () => {
          const newData = await fetchRdsCostOptimizationAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey);
          return newData;
        });
        return res.json(cacheData);
      }
  
      const results = await fetchRdsCostOptimizationAndCache(cacheKey, organizationAccountsAndRegions, accessKey, secretKey);
      return res.json(results);
  
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
  
  async function fetchRdsCostOptimizationAndCache(cacheKey: string, organizationAccountsAndRegions: Record<string, string[]>, accessKey: string, secretKey: string): Promise<CostOptimizationResult[]> {
    const results: CostOptimizationResult[] = [];
  
    // Iterate through each account and its allowed regions
    for (const accountId of Object.keys(organizationAccountsAndRegions)) {
      const allowedRegions = organizationAccountsAndRegions[accountId];
      for (const region of allowedRegions) {
        try {
          const account = { accessKeyId: accessKey, secretAccessKey: secretKey, accountId }; // Create account object
  
          const [instanceId, instanceType, allocatedStorage, storageType, provisionedIops] = await getRDSInstanceInfo(region, accessKey, secretKey, accountId);
  
          const metricData: MetricData = await getRDSMetrics(region, accessKey, secretKey, accountId, instanceId);
  
          const recommendations: CostOptimizationResult = await getCostOptimizationRecommendations(accountId, instanceId, metricData, instanceType, storageType, allocatedStorage, provisionedIops);
  
          if (recommendations.totalCost > 0) {
            results.push(recommendations);
          }
        } catch (error: any) {
          // If "Access Denied" error, log it and continue with next iteration
          if (error.code === 'AccessDenied') {
            // console.error(`Access denied for account ${accountId} in region ${region}:`, error.message);
            continue; 
          }
  
          if (error.message.includes('No RDS instances found')) {
          } else {
            console.error(`Error fetching RDS cost optimization recommendations for account ${accountId} in region ${region}:`, error);
            results.push({
              accountId,
              instanceId: 'Error',
              totalCost: 0,
              recommendations: ['Error fetching recommendations'],
              monthlySavings: 0
            });
          }
        }
      }
    }
  
    setCacheData(cacheKey, results);
  
    return results;
  }