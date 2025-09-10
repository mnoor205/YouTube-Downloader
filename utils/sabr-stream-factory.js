import { createWriteStream } from 'node:fs';
import cliProgress from 'cli-progress';
import { Constants, Innertube, UniversalCache, YTNodes } from 'youtubei.js';

import { generateWebPoToken } from './webpo-helper.js';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat } from 'googlevideo/utils';

export async function makePlayerRequest(innertube, videoId, reloadPlaybackContext) {
  const watchEndpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });

  const extraArgs = {
    playbackContext: {
      adPlaybackContext: { pyv: true },
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        lactMilliseconds: '-1',
        signatureTimestamp: innertube.session.player?.sts
      }
    },
    contentCheckOk: true,
    racyCheckOk: true
  };

  if (reloadPlaybackContext) {
    extraArgs.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
  }

  return await watchEndpoint.call(innertube.actions, { ...extraArgs, parse: true });
}

export function determineFileExtension(mimeType) {
  if (mimeType.includes('video')) {
    return mimeType.includes('webm') ? 'webm' : 'mp4';
  } else if (mimeType.includes('audio')) {
    return mimeType.includes('webm') ? 'webm' : 'm4a';
  }
  return 'bin';
}

export function createOutputStream(title, mimeType) {
  const type = mimeType.includes('video') ? 'video' : 'audio';
  const sanitizedTitle = title?.replace(/[^a-z0-9]/gi, '_') || 'unknown';
  const extension = determineFileExtension(mimeType);
  const fileName = `${sanitizedTitle}.${type}.${extension}`;

  return {
    stream: createWriteStream(fileName, { flags: 'w', encoding: 'binary' }),
    filePath: fileName
  };
}

export function bytesToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function createMultiProgressBar() {
  return new cliProgress.MultiBar({
    stopOnComplete: true,
    hideCursor: true
  }, cliProgress.Presets.rect);
}

export function setupProgressBar(multiBar, type, totalSizeBytes) {
  if (type === 'merge') {
    const bar = multiBar.create(100, 0, undefined, {
      format: `${type} [{bar}] {percentage}%`
    });
    bar.update(0);
    return bar;
  }

  const totalSizeMB = totalSizeBytes ? bytesToMB(totalSizeBytes) : '0.00';
  const bar = multiBar.create(100, 0, undefined, {
    format: `${type} [{bar}] {percentage}% | {currentSizeMB}/{totalSizeMB} MB`
  });

  bar.update(0, { currentSizeMB: '0.00', totalSizeMB });
  return bar;
}

export function createStreamSink(format, outputStream, progressBar) {
  let size = 0;
  const totalSize = Number(format.contentLength || 0);

  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        size += chunk.length;

        if (totalSize > 0 && progressBar) {
          const percentage = (size / totalSize) * 100;
          progressBar.update(percentage, {
            currentSizeMB: bytesToMB(size),
            totalSizeMB: bytesToMB(totalSize)
          });
        }

        outputStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      outputStream.end();
    }
  });
}

export async function createSabrStream(videoId, options) {
  const innertube = await Innertube.create({ cache: new UniversalCache(true) });
  const webPoTokenResult = await generateWebPoToken(innertube.session.context.client.visitorData || '');

  const playerResponse = await makePlayerRequest(innertube, videoId);
  const videoTitle = playerResponse.video_details?.title || 'Unknown Video';

  console.info(`
    Title: ${videoTitle}
    Duration: ${playerResponse.video_details?.duration}
    Views: ${playerResponse.video_details?.view_count}
    Author: ${playerResponse.video_details?.author}
    Video ID: ${playerResponse.video_details?.id}
  `);

  const serverAbrStreamingUrl = innertube.session.player?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
  const videoPlaybackUstreamerConfig = playerResponse.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

  if (!videoPlaybackUstreamerConfig) throw new Error('ustreamerConfig not found');
  if (!serverAbrStreamingUrl) throw new Error('serverAbrStreamingUrl not found');

  const sabrFormats = playerResponse.streaming_data?.adaptive_formats.map(buildSabrFormat) || [];

  const serverAbrStream = new SabrStream({
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    poToken: webPoTokenResult.poToken,
    clientInfo: {
      clientName: parseInt(Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName]),
      clientVersion: innertube.session.context.client.clientVersion
    }
  });

  serverAbrStream.on('reloadPlayerResponse', async (reloadPlaybackContext) => {
    const playerResponse = await makePlayerRequest(innertube, videoId, reloadPlaybackContext);

    const serverAbrStreamingUrl = innertube.session.player?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
    const videoPlaybackUstreamerConfig = playerResponse.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

    if (serverAbrStreamingUrl && videoPlaybackUstreamerConfig) {
      serverAbrStream.setStreamingURL(serverAbrStreamingUrl);
      serverAbrStream.setUstreamerConfig(videoPlaybackUstreamerConfig);
    }
  });

  const { videoStream, audioStream, selectedFormats } = await serverAbrStream.start(options);

  return {
    innertube,
    streamResults: {
      videoStream,
      audioStream,
      selectedFormats,
      videoTitle
    }
  };
}
