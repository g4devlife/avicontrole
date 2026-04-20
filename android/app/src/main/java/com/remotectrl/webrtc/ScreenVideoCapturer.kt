package com.remotectrl.webrtc

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.util.Log
import org.webrtc.*

/**
 * Bridges Android screen capture (MediaProjection) → WebRTC VideoSource.
 *
 * Uses WebRTC's built-in ScreenCapturerAndroid so frames flow directly
 * into WebRTC's encoding pipeline — no separate MediaCodec needed.
 *
 * Architecture:
 *   MediaProjection → VirtualDisplay → SurfaceTexture (SurfaceTextureHelper)
 *       → VideoFrame (texture) → VideoSource.CapturerObserver → VideoTrack → PeerConnection
 */
class ScreenVideoCapturer(
    private val context:     Context,
    private val resultData:  Intent,        // Intent from MediaProjectionManager result
    private val videoSource: VideoSource,
    private val eglContext:  EglBase.Context,
    private val width:       Int,
    private val height:      Int,
    private val fps:         Int = 30,
) {
    companion object {
        const val TAG = "ScreenVideoCapturer"
    }

    private var capturer:             ScreenCapturerAndroid? = null
    private var surfaceTextureHelper: SurfaceTextureHelper?  = null

    fun start() {
        // SurfaceTextureHelper runs on its own thread, shares the EGL context from WebRTC
        surfaceTextureHelper = SurfaceTextureHelper.create("ScreenCapture-Thread", eglContext)

        capturer = ScreenCapturerAndroid(resultData, object : MediaProjection.Callback() {
            override fun onStop() {
                Log.w(TAG, "MediaProjection stopped — nettoyage + restart planifié")
                // Nettoyer le capturer actuel en premier
                stop()
                // Demander à WebRTCManager de redémarrer dès que l'écran se rallume.
                // Le flag AtomicBoolean dans WebRTCManager évitera le double-restart
                // si ACTION_SCREEN_ON / ACTION_USER_PRESENT arrive quasi simultanément.
                WebRTCManager.getInstance(context).restartCapture()
            }
        })

        // Wire: capturer → surfaceTextureHelper → videoSource's internal observer
        capturer!!.initialize(surfaceTextureHelper, context, videoSource.capturerObserver)
        capturer!!.startCapture(width, height, fps)
        Log.i(TAG, "Screen capture started: ${width}x${height} @ ${fps} fps")
    }

    fun stop() {
        try {
            capturer?.stopCapture()
        } catch (e: InterruptedException) {
            Log.w(TAG, "stopCapture interrupted: ${e.message}")
            Thread.currentThread().interrupt()
        }
        capturer?.dispose()
        capturer = null

        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null
        Log.i(TAG, "Screen capture stopped")
    }
}
