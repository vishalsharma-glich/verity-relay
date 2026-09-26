// api/upload-voice.js
// Deploy this on Vercel. Roblox calls this endpoint (allowed, since it's
// NOT a roblox.com domain) with the generated MP3 audio; this function then
// calls Roblox's Open Cloud Assets API itself (allowed, since this code
// runs on Vercel's servers, not inside Roblox's HttpService) and returns
// the resulting asset ID back to Roblox.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

// Grants the game (identified by VERITY_UNIVERSE_ID) permission to use a
// newly-created asset. Without this, Roblox blocks playing an asset inside
// an experience owned by a different account than the one that uploaded it.
// Best-effort: if this fails, we still return the assetId, but playback in
// Studio may show a "Click to share access" warning until granted.
async function grantUniversePermission(assetId, openCloudKey) {
  const universeId = process.env.VERITY_UNIVERSE_ID;
  if (!UNIVERSEID) {
    console.error('[grantUniversePermission] VERITY_UNIVERSE_ID not set, skipping grant.');
    return;
  }
  try {
    const grantRes = await fetch('https://apis.roblox.com/asset-permissions-api/v1/assets/permissions', {
      method: 'PATCH',
      headers: {
        'x-api-key': openCloudKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            assetId: String(assetId),
            subject: {
              subjectType: 'Universe',
              subjectId: String(universeId),
            },
            action: 'Use',
          },
        ],
      }),
    });
    const grantText = await grantRes.text();
    if (!grantRes.ok) {
      console.error('[grantUniversePermission] Grant failed:', grantRes.status, grantText);
    }
  } catch (err) {
    console.error('[grantUniversePermission] Error:', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  // Simple shared-secret check so random people can't hit your endpoint
  // and burn your Open Cloud quota. Set RELAY_SHARED_SECRET in Vercel's
  // environment variables, and send the same value from Roblox.
  const providedSecret = req.headers['x-relay-secret'];
  if (!process.env.RELAY_SHARED_SECRET || providedSecret !== process.env.RELAY_SHARED_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { audioBase64, displayName, creatorUserId } = req.body || {};
  if (!audioBase64 || !creatorUserId) {
    res.status(400).json({ error: 'Missing audioBase64 or creatorUserId' });
    return;
  }

  const openCloudKey = process.env.OPEN_CLOUD_KEY;
  if (!openCloudKey) {
    res.status(500).json({ error: 'Server misconfigured: OPEN_CLOUD_KEY not set' });
    return;
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    const requestJson = JSON.stringify({
      assetType: 'Audio',
      displayName: displayName || `Verity line ${Date.now()}`,
      description: 'Verity voice line',
      creationContext: {
        creator: { userId: String(creatorUserId) },
      },
    });

    const form = new FormData();
    form.append('request', requestJson);
    form.append('fileContent', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'verity.mp3');

    const uploadRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': openCloudKey },
      body: form,
    });

    const uploadText = await uploadRes.text();
    if (!uploadRes.ok) {
      res.status(502).json({ error: 'Open Cloud upload failed', detail: uploadText });
      return;
    }

    let uploadJson = JSON.parse(uploadText);

    // If already done, return immediately
    if (uploadJson.done && uploadJson.response && uploadJson.response.assetId) {
      const assetId = String(uploadJson.response.assetId);
      await grantUniversePermission(assetId, openCloudKey);
      res.status(200).json({ assetId });
      return;
    }

    // Otherwise poll the operation until it's done
    const operationPath = uploadJson.path;
    if (!operationPath) {
      res.status(502).json({ error: 'Unexpected Open Cloud response', detail: uploadText });
      return;
    }

    const deadline = Date.now() + 25000; // 25s budget, Vercel free functions have a time limit
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));

      const pollRes = await fetch(`https://apis.roblox.com/assets/v1/${operationPath}`, {
        headers: { 'x-api-key': openCloudKey },
      });
      const pollJson = await pollRes.json();

      if (pollJson.done) {
        if (pollJson.response && pollJson.response.assetId) {
          const assetId = String(pollJson.response.assetId);
          await grantUniversePermission(assetId, openCloudKey);
          res.status(200).json({ assetId });
          return;
        }
        res.status(502).json({ error: 'Operation finished but no assetId', detail: JSON.stringify(pollJson) });
        return;
      }
    }

    res.status(504).json({ error: 'Timed out waiting for asset processing' });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error', detail: String(err) });
  }
}
