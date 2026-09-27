// api/upload-voice.js
// Verity Relay: Bridges Roblox client voice generation → Fish Audio TTS → Roblox Open Cloud.
// Handles voice asset uploads, moderation queuing, and fallback playback.
//
// Environment variables required:
//   OPEN_CLOUD_KEY           - Roblox Open Cloud API key
//   RELAY_SHARED_SECRET      - Shared secret for Roblox client auth
//   VERITY_UNIVERSE_ID       - Roblox universe ID for asset permissions
//   FALLBACK_AUDIO_ASSET_ID  - Pre-approved Roblox audio asset ID (emergency fallback)

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

/**
 * Logs a message tagged with [Verity Relay].
 */
function log(level, message, ...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Verity Relay] [${level}]`, message, ...args);
}

/**
 * Returns a fallback audio asset ID if configured.
 * The fallback is only used after authentication and basic validation pass.
 * Fallback assets must already be approved by Roblox moderation.
 */
function fallbackResponse(res, reason, status = 200) {
  const fallbackAssetId = process.env.FALLBACK_AUDIO_ASSET_ID;
  if (fallbackAssetId) {
    log('WARN', 'Using fallback asset', { fallbackAssetId, reason });
    res.status(status).json({
      assetId: String(fallbackAssetId),
      fallback: true,
      reason,
    });
    return true;
  }
  log('WARN', 'No fallback configured; returning error instead', { reason });
  return false;
}

/**
 * Grants the Verity universe permission to use a newly-uploaded audio asset.
 * This allows the game to play the asset without additional permissions.
 */
async function grantUniversePermission(assetId, openCloudKey) {
  const universeId = process.env.VERITY_UNIVERSE_ID;
  if (!universeId) {
    log('WARN', 'VERITY_UNIVERSE_ID not set; skipping permission grant');
    return;
  }

  try {
    log('INFO', 'Granting universe permission', { assetId, universeId });

    const grantRes = await fetch(
      'https://apis.roblox.com/asset-permissions-api/v1/assets/permissions',
      {
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
      }
    );

    const grantText = await grantRes.text();
    if (!grantRes.ok) {
      log('ERROR', 'Permission grant failed', {
        status: grantRes.status,
        detail: grantText,
      });
    } else {
      log('INFO', 'Permission granted successfully', {
        assetId,
        universeId,
      });
    }
  } catch (err) {
    // Do not replace a valid uploaded asset with fallback just because
    // the permission call failed; the asset ID is still useful for diagnostics.
    log('ERROR', 'Permission grant error', { error: err.message });
  }
}

/**
 * Main Verity Relay handler.
 * Receives base64-encoded MP3 audio from Roblox client.
 * Uploads to Roblox Open Cloud and returns assetId.
 */
export default async function handler(req, res) {
  log('INFO', 'Request received', { method: req.method });

  // === REQUEST VALIDATION ===
  if (req.method !== 'POST') {
    log('WARN', 'Invalid method', { method: req.method });
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  // === AUTHENTICATION ===
  const providedSecret = req.headers['x-relay-secret'];
  const expectedSecret = process.env.RELAY_SHARED_SECRET;

  if (!expectedSecret) {
    log('ERROR', 'RELAY_SHARED_SECRET not configured');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  if (providedSecret !== expectedSecret) {
    log('WARN', 'Authentication failed: invalid secret');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  log('INFO', 'Authentication passed');

  // === PAYLOAD VALIDATION ===
  const { audioBase64, displayName, creatorUserId } = req.body || {};

  if (!audioBase64 || !creatorUserId) {
    log('WARN', 'Missing required fields', {
      hasAudioBase64: !!audioBase64,
      hasCreatorUserId: !!creatorUserId,
    });
    res.status(400).json({ error: 'Missing audioBase64 or creatorUserId' });
    return;
  }

  log('INFO', 'Payload validated', {
    audioBase64Length: audioBase64.length,
    displayName,
    creatorUserId,
  });

  // === OPEN CLOUD KEY CHECK ===
  const openCloudKey = process.env.OPEN_CLOUD_KEY;
  if (!openCloudKey) {
    if (fallbackResponse(res, 'OPEN_CLOUD_KEY is not configured')) return;
    log('ERROR', 'OPEN_CLOUD_KEY not configured');
    res.status(500).json({ error: 'Server misconfigured: OPEN_CLOUD_KEY not set' });
    return;
  }

  log('INFO', 'Open Cloud key loaded');

  try {
    // === AUDIO DECODING ===
    log('INFO', 'Decoding audio from base64', { length: audioBase64.length });

    const audioBuffer = Buffer.from(audioBase64, 'base64');

    if (!audioBuffer.length) {
      log('WARN', 'Decoded audio is empty');
      if (fallbackResponse(res, 'decoded audio is empty')) return;
      res.status(400).json({ error: 'audioBase64 decoded to an empty file' });
      return;
    }

    log('INFO', 'Audio decoded successfully', { bufferSize: audioBuffer.length });

    // === UPLOAD PREPARATION ===
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
    form.append(
      'fileContent',
      new Blob([audioBuffer], { type: 'audio/mpeg' }),
      'verity.mp3'
    );

    log('INFO', 'Uploading to Roblox Open Cloud');

    // === ROBLOX OPEN CLOUD UPLOAD ===
    const uploadRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': openCloudKey },
      body: form,
    });

    const uploadText = await uploadRes.text();

    if (!uploadRes.ok) {
      log('ERROR', 'Open Cloud upload failed', {
        status: uploadRes.status,
        response: uploadText.substring(0, 200),
      });
      if (fallbackResponse(res, `Open Cloud upload failed (${uploadRes.status})`))
        return;
      res.status(502).json({
        error: 'Open Cloud upload failed',
        detail: uploadText,
      });
      return;
    }

    log('INFO', 'Upload response received', { status: uploadRes.status });

    // === RESPONSE PARSING ===
    let uploadJson;
    try {
      uploadJson = JSON.parse(uploadText);
    } catch (err) {
      log('ERROR', 'Failed to parse Open Cloud response', {
        error: err.message,
        response: uploadText.substring(0, 200),
      });
      if (fallbackResponse(res, 'Open Cloud returned invalid JSON')) return;
      res.status(502).json({
        error: 'Invalid Open Cloud response',
        detail: uploadText,
      });
      return;
    }

    // === IMMEDIATE SUCCESS (synchronous) ===
    if (uploadJson.done && uploadJson.response && uploadJson.response.assetId) {
      const assetId = String(uploadJson.response.assetId);
      log('INFO', 'Asset created immediately (synchronous)', { assetId });

      await grantUniversePermission(assetId, openCloudKey);

      res.status(200).json({
        assetId,
        fallback: false,
      });
      return;
    }

    // === ASYNC PROCESSING (operation path) ===
    const operationPath = uploadJson.path;
    if (!operationPath) {
      log('ERROR', 'No operation path in response', {
        response: JSON.stringify(uploadJson).substring(0, 200),
      });
      if (
        fallbackResponse(
          res,
          'Open Cloud response did not include an operation path'
        )
      )
        return;
      res.status(502).json({
        error: 'Unexpected Open Cloud response',
        detail: uploadText,
      });
      return;
    }

    log('INFO', 'Asset queued for async processing', { operationPath });

    // === POLLING FOR COMPLETION ===
    // Keep the synchronous wait short (25s). If processing takes longer,
    // return the fallback asset instead of making the Roblox request hang.
    const deadline = Date.now() + 25000;
    let pollCount = 0;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      pollCount++;

      log('INFO', `Polling for asset completion (attempt ${pollCount})`);

      const pollRes = await fetch(`https://apis.roblox.com/assets/v1/${operationPath}`, {
        headers: { 'x-api-key': openCloudKey },
      });

      if (!pollRes.ok) {
        const pollText = await pollRes.text();
        log('ERROR', 'Polling failed', {
          status: pollRes.status,
          detail: pollText.substring(0, 200),
        });
        if (fallbackResponse(res, `Open Cloud polling failed (${pollRes.status})`))
          return;
        res.status(502).json({
          error: 'Open Cloud polling failed',
          detail: pollText,
        });
        return;
      }

      const pollJson = await pollRes.json();

      if (pollJson.done) {
        if (pollJson.response && pollJson.response.assetId) {
          const assetId = String(pollJson.response.assetId);
          log('INFO', 'Asset processing completed', {
            assetId,
            pollAttempts: pollCount,
          });

          await grantUniversePermission(assetId, openCloudKey);

          res.status(200).json({
            assetId,
            fallback: false,
          });
          return;
        }

        log('ERROR', 'Operation finished but no assetId', {
          response: JSON.stringify(pollJson).substring(0, 200),
        });
        if (fallbackResponse(res, 'Open Cloud operation finished without an assetId'))
          return;
        res.status(502).json({
          error: 'Operation finished but no assetId',
          detail: JSON.stringify(pollJson),
        });
        return;
      }

      log('INFO', `Still processing (attempt ${pollCount})`, {
        done: pollJson.done,
      });
    }

    // === TIMEOUT ===
    log('WARN', 'Asset processing timed out after 25 seconds', { pollCount });
    if (fallbackResponse(res, 'Timed out waiting for asset processing')) return;
    res.status(504).json({
      error: 'Timed out waiting for asset processing',
    });
  } catch (err) {
    log('ERROR', 'Unexpected error', {
      message: err.message,
      stack: err.stack.substring(0, 200),
    });
    if (fallbackResponse(res, 'Unexpected relay error')) return;
    res.status(500).json({
      error: 'Unexpected error',
      detail: String(err),
    });
  }
}
