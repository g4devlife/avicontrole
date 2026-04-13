package com.remotectrl.webrtc

import android.content.Context
import android.content.Intent
import android.util.Log
import com.remotectrl.pairing.PairingManager
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

    private var socket:             Socket?               = null
    private var peerConnection:     PeerConnection?       = null
    private var factory:            PeerConnectionFactory? = null
    private var videoSource:        VideoSource?          = null
    private var videoTrack:         VideoTrack?           = null
    private var screenCapturer:     ScreenVideoCapturer?  = null
    private var eglBase:            EglBase?              = null
    private var isStreaming         = false

    // Stored for deferred use when desktop joins
    private var pendingResultData:  Intent? = null
    private var pendingWidth:       Int     = 0
    private var pendingHeight:      Int     = 0

    private val iceServers = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        // Ajouter votre serveur TURN ici si NAT symétrique
    )

    // ──────────────────────────────────────────
    //  Démarrage du streaming
    //  resultData  = Intent retourné par MediaProjectionManager
    //  width/height = résolution de l'écran (pixels)
    // ──────────────────────────────────────────

    fun startStreaming(resultData: Intent, width: Int, height: Int) {
        pendingResultData = resultData
        pendingWidth      = width
        pendingHeight     = height

        initWebRTC()
        connectSignaling()
        isStreaming = true
    }

    fun stopStreaming() {
        isStreaming = false
        screenCapturer?.stop()
        screenCapturer = null
        peerConnection?.close()
        peerConnection = null
        socket?.disconnect()
        socket = null
        videoTrack?.dispose()
        videoTrack = null
        videoSource?.dispose()
        videoSource = null
        factory?.dispose()
        factory = null
        eglBase?.release()
        eglBase = null
    }

    // ──────────────────────────────────────────
    //  Init WebRTC factory + EGL
    // ──────────────────────────────────────────

    private fun initWebRTC() {
        eglBase = EglBase.create()
        val eglContext = eglBase!!.eglBaseContext

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )

        val encoderFactory = DefaultVideoEncoderFactory(eglContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglContext)

        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
    }

    // ──────────────────────────────────────────
    //  Connexion signaling
    // ──────────────────────────────────────────

    private fun connectSignaling() {
        val pairing   = PairingManager.getInstance(context)
        val serverUrl = pairing.getServerUrl()
        socket = IO.socket(serverUrl)

        socket!!.on(Socket.EVENT_CONNECT) {
            Log.i(TAG, "Signaling connecté")
            val pcAccountId = pairing.getPcAccountId() ?: run {
                Log.e(TAG, "Téléphone non associé — déconnexion")
                socket!!.emit("error", JSONObject().put("message", "Téléphone non associé"))
                socket!!.disconnect()
                return@on
            }
            val deviceFP = android.provider.Settings.Secure.getString(
                context.contentResolver,
                android.provider.Settings.Secure.ANDROID_ID,
            )
            socket!!.emit("android:create-session", JSONObject().apply {
                put("pcAccountId",       pcAccountId)
                put("deviceFingerprint", deviceFP)
            })
        }

        socket!!.on("android:session-created") { args ->
            val code = (args[0] as JSONObject).getString("sessionCode")
            Log.i(TAG, "Session créée: $code")
            SessionCodeEventBus.post(code)
            createPeerConnection()
        }

        socket!!.on("android:desktop-joined") {
            Log.i(TAG, "Desktop rejoint — envoi offer SDP")
            startScreenCapture()
            createOffer()
        }

        socket!!.on("webrtc:answer") { args ->
            val sdpJson = (args[0] as JSONObject).getJSONObject("sdp")
            val sdp = SessionDescription(
                SessionDescription.Type.fromCanonicalForm(sdpJson.getString("type")),
                sdpJson.getString("sdp"),
            )
            peerConnection?.setRemoteDescription(SimpleSdpObserver("setRemoteDesc"), sdp)
        }

        socket!!.on("webrtc:ice-candidate") { args ->
            val c = (args[0] as JSONObject).getJSONObject("candidate")
            peerConnection?.addIceCandidate(IceCandidate(
                c.getString("sdpMid"),
                c.getInt("sdpMLineIndex"),
                c.getString("candidate"),
            ))
        }

        socket!!.on("control:event") { args ->
            try {
                ControlAccessibilityService.getInstance()?.handleEvent(args[0] as JSONObject)
            } catch (e: Exception) {
                Log.e(TAG, "Erreur commande: ${e.message}")
            }
        }

        socket!!.on("android:desktop-left") {
            Log.i(TAG, "Desktop déconnecté")
            SessionCodeEventBus.postDesktopLeft()
        }

        socket!!.on("error") { args ->
            Log.e(TAG, "Erreur signaling: ${args[0]}")
        }

        socket!!.connect()
    }

    // ──────────────────────────────────────────
    //  Création PeerConnection + VideoSource
    // ──────────────────────────────────────────

    private fun createPeerConnection() {
        // VideoSource isScreencast=true → WebRTC adapts bitrate/fps for screen content
        videoSource = factory!!.createVideoSource(/* isScreencast= */ true)
        videoTrack  = factory!!.createVideoTrack("video0", videoSource)

        peerConnection = factory!!.createPeerConnection(
            PeerConnection.RTCConfiguration(iceServers),
            object : PeerConnection.Observer {
                override fun onIceCandidate(candidate: IceCandidate) {
                    socket?.emit("webrtc:ice-candidate", JSONObject().apply {
                        put("candidate", JSONObject().apply {
                            put("candidate",     candidate.sdp)
                            put("sdpMid",        candidate.sdpMid)
                            put("sdpMLineIndex", candidate.sdpMLineIndex)
                        })
                    })
                }

                override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                    Log.i(TAG, "PeerConnection: $state")
                }

                override fun onDataChannel(dc: DataChannel)           { setupDataChannel(dc) }
                override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
                override fun onSignalingChange(p0: PeerConnection.SignalingState?)  {}
                override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
                override fun onIceConnectionReceivingChange(p0: Boolean) {}
                override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
                override fun onAddStream(p0: MediaStream?) {}
                override fun onRemoveStream(p0: MediaStream?) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
            },
        )

        val stream = factory!!.createLocalMediaStream("stream0")
        stream.addTrack(videoTrack)
        peerConnection!!.addStream(stream)
    }

    // ──────────────────────────────────────────
    //  Démarrage de la capture d'écran réelle
    //  (appelé uniquement quand le desktop a rejoint)
    // ──────────────────────────────────────────

    private fun startScreenCapture() {
        val data   = pendingResultData ?: return
        val vs     = videoSource        ?: return
        val egl    = eglBase            ?: return

        screenCapturer = ScreenVideoCapturer(
            context    = context,
            resultData = data,
            videoSource = vs,
            eglContext  = egl.eglBaseContext,
            width       = pendingWidth,
            height      = pendingHeight,
            fps         = 30,
        )
        screenCapturer!!.start()
    }

    // ──────────────────────────────────────────
    //  Création de l'offer SDP
    // ──────────────────────────────────────────

    private fun createOffer() {
        peerConnection?.createOffer(object : SimpleSdpObserver("createOffer") {
            override fun onCreateSuccess(sdp: SessionDescription) {
                peerConnection?.setLocalDescription(SimpleSdpObserver("setLocalDesc"), sdp)
                socket?.emit("webrtc:offer", JSONObject().apply {
                    put("sdp", JSONObject().apply {
                        put("type", sdp.type.canonicalForm())
                        put("sdp",  sdp.description)
                    })
                })
            }
        }, MediaConstraints())
    }

    // ──────────────────────────────────────────
    //  DataChannel : commandes tactiles
    // ──────────────────────────────────────────

    private fun setupDataChannel(dc: DataChannel) {
        dc.registerObserver(object : DataChannel.Observer {
            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                try {
                    ControlAccessibilityService.getInstance()?.handleEvent(JSONObject(String(bytes)))
                } catch (e: Exception) {
                    Log.e(TAG, "DataChannel message error: ${e.message}")
                }
            }
            override fun onBufferedAmountChange(l: Long) {}
            override fun onStateChange() {}
        })
    }
}

// ── Event bus simple pour envoyer le code session à l'UI ──────────────
object SessionCodeEventBus {
    var listener:             ((String) -> Unit)? = null
    var desktopLeftListener:  (() -> Unit)?       = null

    fun post(code: String) { listener?.invoke(code) }
    fun postDesktopLeft()  { desktopLeftListener?.invoke() }
}

// ── SdpObserver de base ────────────────────────────────────────────────
open class SimpleSdpObserver(private val tag: String) : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) {}
    override fun onSetSuccess()    {}
    override fun onCreateFailure(err: String) { Log.e("SdpObserver", "$tag create: $err") }
    override fun onSetFailure(err: String)    { Log.e("SdpObserver", "$tag set: $err") }
}
