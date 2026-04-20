package com.remotectrl.webrtc

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.remotectrl.pairing.PairingManager
import com.remotectrl.ui.MainActivity
import com.remotectrl.service.ControlAccessibilityService
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import org.webrtc.*
import java.nio.ByteBuffer

class WebRTCManager private constructor(private val context: Context) {

    companion object {
        const val TAG = "WebRTCManager"

        @Volatile private var INSTANCE: WebRTCManager? = null
        fun getInstance(ctx: Context): WebRTCManager =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: WebRTCManager(ctx.applicationContext).also { INSTANCE = it }
            }
    }

    private var socket:          Socket?               = null
    private var peerConnection:  PeerConnection?       = null
    private var factory:         PeerConnectionFactory? = null
    private var videoSource:     VideoSource?          = null
    private var videoTrack:      VideoTrack?           = null
    private var screenCapturer:  ScreenVideoCapturer?  = null
    private var eglBase:         EglBase?              = null
    private var isStreaming      = false
    private var isCapturing      = false

    private var pendingResultData: Intent? = null
    private var pendingWidth:      Int     = 0
    private var pendingHeight:     Int     = 0

    // Évite les redémarrages de capture en double (ex: onStop + ACTION_SCREEN_ON simultanés)
    private val mainHandler       = android.os.Handler(android.os.Looper.getMainLooper())
    private val restartScheduled  = java.util.concurrent.atomic.AtomicBoolean(false)

    var onConnected:    (() -> Unit)? = null
    var onDisconnected: (() -> Unit)? = null

    private val iceServers = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
    )

    // ── Démarrage ────────────────────────────────────────────────

    fun startStreaming(
        resultData:     Intent,
        width:          Int,
        height:         Int,
        onConnected:    (() -> Unit)? = null,
        onDisconnected: (() -> Unit)? = null,
    ) {
        if (isStreaming) {
            Log.w(TAG, "Streaming déjà en cours, mise à jour des callbacks")
            this.onConnected = onConnected
            this.onDisconnected = onDisconnected
            return
        }

        this.onConnected    = onConnected
        this.onDisconnected = onDisconnected
        
        // Limitation de la résolution pour la stabilité (max 1280px de hauteur)
        // Les dimensions doivent être paires pour de nombreux encodeurs
        val maxH = 1280
        if (height > maxH) {
            pendingWidth  = ((width * (maxH.toFloat() / height)).toInt() / 2) * 2
            pendingHeight = maxH
        } else {
            pendingWidth  = (width / 2) * 2
            pendingHeight = (height / 2) * 2
        }

        pendingResultData   = resultData
        isStreaming         = true
        isCapturing         = false

        try {
            initWebRTC()
            connectSignaling()
        } catch (e: Exception) {
            Log.e(TAG, "Erreur démarrage: ${e.message}", e)
        }
    }

    fun stopStreaming() {
        isStreaming  = false
        isCapturing  = false
        onConnected    = null
        onDisconnected = null
        try {
            screenCapturer?.stop()
            peerConnection?.close()
            socket?.disconnect()
            videoTrack?.dispose()
            videoSource?.dispose()
            factory?.dispose()
            eglBase?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Erreur arrêt: ${e.message}")
        } finally {
            screenCapturer = null
            peerConnection = null
            socket         = null
            videoTrack     = null
            videoSource    = null
            factory        = null
            eglBase        = null
        }
    }

    // ── Init WebRTC ───────────────────────────────────────────────

    private fun initWebRTC() {
        if (factory != null) return

        eglBase = EglBase.create()
        val eglContext = eglBase?.eglBaseContext ?: throw IllegalStateException("EglBase init failed")

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        val encoderFactory = SoftwareVideoEncoderFactory()
        val decoderFactory = SoftwareVideoDecoderFactory()

        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()

        // Initialiser la source et la piste vidéo une seule fois pour toute la session
        videoSource = factory?.createVideoSource(true)
        videoTrack  = factory?.createVideoTrack("video0", videoSource)

        // Démarrer la capture d'écran immédiatement (évite de réutiliser l'Intent plus tard)
        startScreenCapture()
    }

    // ── Connexion signaling ───────────────────────────────────────

    private fun connectSignaling() {
        if (socket != null) return

        val pairing   = PairingManager.getInstance(context)
        val serverUrl = pairing.getServerUrl()

        val opts = IO.Options().apply {
            reconnection        = true
            reconnectionDelay   = 2000
            reconnectionDelayMax = 10000
        }
        socket = IO.socket(serverUrl, opts)

        val deviceFP = android.provider.Settings.Secure.getString(
            context.contentResolver,
            android.provider.Settings.Secure.ANDROID_ID,
        ) ?: "unknown"

        fun registerSession() {
            if (!isStreaming) return
            val pcAccountId = pairing.getPcAccountId() ?: run {
                Log.e(TAG, "Téléphone non associé")
                return
            }
            try {
                socket?.emit("android:create-session", JSONObject().apply {
                    put("pcAccountId",       pcAccountId)
                    put("deviceFingerprint", deviceFP)
                    put("localIp",           getLocalIp())
                })
            } catch (e: Exception) {
                Log.e(TAG, "Erreur register session: ${e.message}")
            }
        }

        socket?.on(Socket.EVENT_CONNECT) {
            if (!isStreaming) return@on
            Log.i(TAG, "Signaling connecté")
            // Reconnexion : réinitialiser peer connection si elle existait
            if (peerConnection != null && factory != null) {
                try {
                    peerConnection?.close()
                    peerConnection = null
                    isCapturing = false
                    safeMakePeerConnection()
                } catch (e: Exception) {
                    Log.e(TAG, "Erreur reset peer: ${e.message}")
                }
            }
            registerSession()
        }

        socket?.on("android:session-created") { args ->
            if (!isStreaming) return@on
            try {
                val code = (args[0] as JSONObject).getString("sessionCode")
                Log.i(TAG, "Session créée: $code")
                if (peerConnection == null) safeMakePeerConnection()
            } catch (e: Exception) {
                Log.e(TAG, "Erreur session-created: ${e.message}")
            }
        }

        socket?.on("android:desktop-joined") {
            if (!isStreaming) return@on
            Log.i(TAG, "Desktop rejoint")
            if (!isCapturing) {
                isCapturing = true
                try {
                    createOffer()
                } catch (e: Exception) {
                    Log.e(TAG, "Erreur création offre: ${e.message}")
                }
            }
            onConnected?.invoke()
            LocalBroadcastManager.getInstance(context)
                .sendBroadcast(Intent(MainActivity.ACTION_DESKTOP_JOINED))
        }

        socket?.on("webrtc:answer") { args ->
            if (!isStreaming) return@on
            try {
                val sdpJson = (args[0] as JSONObject).getJSONObject("sdp")
                val sdp = SessionDescription(
                    SessionDescription.Type.fromCanonicalForm(sdpJson.getString("type")),
                    sdpJson.getString("sdp"),
                )
                peerConnection?.setRemoteDescription(SimpleSdpObserver("setRemoteDesc"), sdp)
            } catch (e: Exception) {
                Log.e(TAG, "Erreur webrtc:answer: ${e.message}")
            }
        }

        socket?.on("webrtc:ice-candidate") { args ->
            if (!isStreaming) return@on
            try {
                val c = (args[0] as JSONObject).getJSONObject("candidate")
                peerConnection?.addIceCandidate(IceCandidate(
                    c.getString("sdpMid"),
                    c.getInt("sdpMLineIndex"),
                    c.getString("candidate"),
                ))
            } catch (e: Exception) {
                Log.e(TAG, "Erreur ice-candidate: ${e.message}")
            }
        }

        socket?.on("control:event") { args ->
            val json = args.getOrNull(0) as? JSONObject ?: return@on
            try {
                if (json.optString("type") == "copy") {
                    // Lire le texte sélectionné et le renvoyer au desktop
                    val text = ControlAccessibilityService.getInstance()?.getSelectedText()
                        ?: run {
                            val cb = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                                    as android.content.ClipboardManager
                            cb.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
                        }
                    socket?.emit("android:clipboard", JSONObject().apply { put("content", text) })
                } else {
                    ControlAccessibilityService.getInstance()?.handleEvent(json)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Erreur commande: ${e.message}")
            }
        }

        socket?.on("android:desktop-left") {
            Log.i(TAG, "Desktop déconnecté")
            isCapturing = false
            onDisconnected?.invoke()
            LocalBroadcastManager.getInstance(context)
                .sendBroadcast(Intent(MainActivity.ACTION_DESKTOP_LEFT))
        }

        socket?.on("error") { args ->
            Log.e(TAG, "Erreur signaling: ${args.getOrNull(0)}")
        }

        socket?.connect()
    }

    // ── PeerConnection ────────────────────────────────────────────

    private fun safeMakePeerConnection() {
        val f = factory ?: return
        try {
            val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }

            peerConnection = f.createPeerConnection(
                rtcConfig,
                object : PeerConnection.Observer {
                    override fun onIceCandidate(candidate: IceCandidate) {
                        try {
                            socket?.emit("webrtc:ice-candidate", JSONObject().apply {
                                put("candidate", JSONObject().apply {
                                    put("candidate",     candidate.sdp)
                                    put("sdpMid",        candidate.sdpMid)
                                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                                })
                            })
                        } catch (e: Exception) {
                            Log.e(TAG, "Erreur ice emit: ${e.message}")
                        }
                    }
                    override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                        Log.i(TAG, "PeerConnection: $state")
                    }
                    override fun onDataChannel(dc: DataChannel)                             { setupDataChannel(dc) }
                    override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?)       {}
                    override fun onSignalingChange(p0: PeerConnection.SignalingState?)      {}
                    override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
                    override fun onIceConnectionReceivingChange(p0: Boolean)                {}
                    override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
                    override fun onAddStream(p0: MediaStream?)                              {}
                    override fun onRemoveStream(p0: MediaStream?)                           {}
                    override fun onRenegotiationNeeded()                                    {}
                    override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
                },
            )

            videoTrack?.let {
                peerConnection?.addTrack(it, listOf("stream0"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Erreur création peer connection: ${e.message}", e)
        }
    }

    // ── Capture d'écran ───────────────────────────────────────────

    private fun startScreenCapture() {
        val data = pendingResultData ?: return
        val vs   = videoSource       ?: return
        val egl  = eglBase           ?: return

        screenCapturer = ScreenVideoCapturer(
            context     = context,
            resultData  = data,
            videoSource = vs,
            eglContext  = egl.eglBaseContext,
            width       = pendingWidth,
            height      = pendingHeight,
            fps         = 30,
        )
        screenCapturer?.start()
    }

    // ── Offer SDP ─────────────────────────────────────────────────

    private fun createOffer() {
        peerConnection?.createOffer(object : SimpleSdpObserver("createOffer") {
            override fun onCreateSuccess(sdp: SessionDescription) {
                try {
                    peerConnection?.setLocalDescription(SimpleSdpObserver("setLocalDesc"), sdp)
                    socket?.emit("webrtc:offer", JSONObject().apply {
                        put("sdp", JSONObject().apply {
                            put("type", sdp.type.canonicalForm())
                            put("sdp",  sdp.description)
                        })
                    })
                } catch (e: Exception) {
                    Log.e(TAG, "Erreur offer: ${e.message}")
                }
            }
        }, MediaConstraints())
    }

    // ── Redémarrage capture (après rallumage écran) ────────────────

    fun restartCapture() {
        if (!isStreaming || !isCapturing) return
        // Dedup : si un restart est déjà planifié (ex: onStop + ACTION_SCREEN_ON simultanés)
        if (restartScheduled.getAndSet(true)) {
            Log.d(TAG, "Restart déjà planifié, ignoré")
            return
        }
        Log.i(TAG, "Redémarrage capture écran planifié")
        try {
            screenCapturer?.stop()
            screenCapturer = null
        } catch (e: Exception) {
            Log.w(TAG, "stop capturer: ${e.message}")
        }
        // Attendre sur un thread non-UI — jamais Thread.sleep sur le main thread
        mainHandler.postDelayed({
            restartScheduled.set(false)
            if (isStreaming && isCapturing) {
                Log.i(TAG, "Redémarrage capture écran — démarrage")
                startScreenCapture()
            }
        }, 400L)
    }

    // ── Émission des champs de saisie vers le desktop ─────────────

    fun emitInputFields(fields: org.json.JSONArray) {
        if (!isStreaming) return
        try {
            socket?.emit("android:fields", JSONObject().apply { put("fields", fields) })
        } catch (e: Exception) {
            Log.e(TAG, "Erreur emitInputFields: ${e.message}")
        }
    }

    private fun getLocalIp(): String {
        return try {
            val ifaces = java.net.NetworkInterface.getNetworkInterfaces() ?: return "unknown"
            java.util.Collections.list(ifaces)
                .asSequence()
                .filter { !it.isLoopback && it.isUp }
                .flatMap { java.util.Collections.list(it.inetAddresses).asSequence() }
                .filterIsInstance<java.net.Inet4Address>()
                .filter { !it.isLoopbackAddress }
                .map { it.hostAddress ?: "" }
                .firstOrNull { it.isNotEmpty() } ?: "unknown"
        } catch (e: Exception) {
            Log.e(TAG, "getLocalIp: ${e.message}")
            "unknown"
        }
    }

    // ── DataChannel ───────────────────────────────────────────────

    private fun setupDataChannel(dc: DataChannel) {
        dc.registerObserver(object : DataChannel.Observer {
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                try {
                    val json = JSONObject(String(bytes))
                    Log.d(TAG, "Control event (DataChannel): $json")
                    ControlAccessibilityService.getInstance()?.handleEvent(json)
                } catch (e: Exception) {
                    Log.e(TAG, "DataChannel error: ${e.message}")
                }
            }
            override fun onBufferedAmountChange(l: Long) {}
            override fun onStateChange() {}
        })
    }
}

// ── SdpObserver ───────────────────────────────────────────────────────────
open class SimpleSdpObserver(private val tag: String) : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) {}
    override fun onSetSuccess()    {}
    override fun onCreateFailure(err: String) { Log.e("SdpObserver", "$tag create: $err") }
    override fun onSetFailure(err: String)    { Log.e("SdpObserver", "$tag set: $err") }
}
