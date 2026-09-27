// api/upload-voice.js
// Deploy this on Vercel. Roblox calls this endpoint with generated MP3 audio.
// If upload/moderation/processing is unavailable, the endpoint can return a
// pre-approved fallback asset so the Roblox voice pipeline still has a line to play.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

// Configure FALLBACK_AUDIO_ASSET_ID in Vercel with an already-approved Roblox
// audio asset ID. The Roblox script can continue using the returned assetId.
// The fallback is only used after authentication and request validation succeed.
function fallbackResponse(res, reason, status = 200) {
  const fallbackAssetId = process.env.FALLBACK_AUDIO_ASSET_ID;
  if (fallbackAssetId) {
    console.warn('[upload-voice] Using fallback asset:', fallbackAssetId, 'reason:', reason);
    res.status(status).json({
      assetId: String(fallbackAssetId),
      fallback: true,
      reason,
    });
    return true;
  }
  return false;
}

// Grants the game permission to use the newly-created asset.
async function grantUniversePermission(assetId, openCloudKey) {
  const universeId = process.env.VERITY_UNIVERSE_ID;
  if (!universeId) {
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
        subjectType: 'Universe',
        subjectId: String(universeId),
        action: 'Use',
        requests: [{ assetId: String(assetId) }],
      }),
    });

    const grantText = await grantRes.text();
    if (!grantRes.ok) {
      console.error('[grantUniversePermission] Grant failed:', grantRes.status, grantText);
    } else {
      console.log('[grantUniversePermission] Granted asset', assetId, 'to universe', universeId);
    }
  } catch (err) {
    // Do not replace a valid uploaded asset with the fallback just because the
    // permission call failed; the asset ID is still useful for diagnostics.
    console.error('[grantUniversePermission] Error:', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

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
    if (fallbackResponse(res, 'OPEN_CLOUD_KEY is not configured')) return;
    res.status(500).json({ error: 'Server misconfigured: OPEN_CLOUD_KEY not set' });
    return;
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    if (!audioBuffer.length) {
      if (fallbackResponse(res, 'decoded audio is empty')) return;
      res.status(400).json({ error: 'audioBase64 decoded to an empty file' });
      return;
    }

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
      if (fallbackResponse(res, `Open Cloud upload failed (${uploadRes.status})`)) return;
      res.status(502).json({ error: 'Open Cloud upload failed', detail: uploadText });
      return;
    }

    let uploadJson;
    try {
      uploadJson = JSON.parse(uploadText);
    } catch (err) {
      if (fallbackResponse(res, 'Open Cloud returned invalid JSON')) return;
      res.status(502).json({ error: 'Invalid Open Cloud response', detail: uploadText });
      return;
    }

    if (uploadJson.done && uploadJson.response && uploadJson.response.assetId) {
      const assetId = String(uploadJson.response.assetId);
      await grantUniversePermission(assetId, openCloudKey);
      res.status(200).json({ assetId, fallback: false });
      return;
    }

    const operationPath = uploadJson.path;
    if (!operationPath) {
      if (fallbackResponse(res, 'Open Cloud response did not include an operation path')) return;
      res.status(502).json({ error: 'Unexpected Open Cloud response', detail: uploadText });
      return;
    }

    // Keep the synchronous wait short. If Roblox processing takes longer,
    // return the known-good fallback instead of making the Roblox request hang.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const pollRes = await fetch(`https://apis.roblox.com/assets/v1/${operationPath}`, {
        headers: { 'x-api-key': openCloudKey },
      });

      if (!pollRes.ok) {
        const pollText = await pollRes.text();
        if (fallbackResponse(res, `Open Cloud polling failed (${pollRes.status})`)) return;
        res.status(502).json({ error: 'Open Cloud polling failed', detail: pollText });
        return;
      }

      const pollJson = await pollRes.json();
      if (pollJson.done) {
        if (pollJson.response && pollJson.response.assetId) {
          const assetId = String(pollJson.response.assetId);
          await grantUniversePermission(assetId, openCloudKey);
          res.status(200).json({ assetId, fallback: false });
          return;
        }

        if (fallbackResponse(res, 'Open Cloud operation finished without an assetId')) return;
        res.status(502).json({
          error: 'Operation finished but no assetId',
          detail: JSON.stringify(pollJson),
        });
        return;
      }
    }

    if (fallbackResponse(res, 'Timed out waiting for asset processing')) return;
    res.status(504).json({ error: 'Timed out waiting for asset processing' });
  } catch (err) {
    console.error('[upload-voice] Unexpected error:', err);
    if (fallbackResponse(res, 'Unexpected relay error')) return;
    res.status(500).json({ error: 'Unexpected error', detail: String(err) });
  }
}
