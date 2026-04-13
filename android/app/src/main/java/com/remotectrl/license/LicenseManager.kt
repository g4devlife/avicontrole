package com.remotectrl.license

import android.content.Context
import android.provider.Settings
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.remotectrl.pairing.PairingManager
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest

/**
 * Gestion de la licence côté Android :
 * - Stockage chiffré de la clé de licence
 * - Activation via API
 * - Validation locale (cache 24h) + distante
 */
class LicenseManager private constructor(private val context: Context) {

    companion object {
        @Volatile private var INSTANCE: LicenseManager? = null
        fun getInstance(ctx: Context): LicenseManager =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: LicenseManager(ctx.applicationContext).also { INSTANCE = it }
            }
    }

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "license_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val http = OkHttpClient()

    // ──────────────────────────────────────────
    //  Activation d'une nouvelle licence
    // ──────────────────────────────────────────

    fun activateLicense(
        licenseKey:  String,
        onSuccess:   (String) -> Unit,
        onError:     (String) -> Unit,
    ) {
        val body = JSONObject().apply {
            put("licenseKey",        licenseKey.trim().uppercase())
            put("deviceFingerprint", getDeviceFingerprint())
            put("deviceName",        getDeviceName())
        }.toString()

        val request = Request.Builder()
            .url("${PairingManager.getInstance(context).getServerUrl()}/api/license/activate")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onError("Erreur réseau: ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                val json = JSONObject(response.body!!.string())
                if (json.optBoolean("success")) {
                    // Sauvegarder localement (chiffré)
                    prefs.edit()
                        .putString("license_key",     licenseKey.trim().uppercase())
                        .putString("device_fp",       getDeviceFingerprint())
                        .putLong("last_validated_at", System.currentTimeMillis())
                        .apply()
                    onSuccess(json.optString("message", "Activé !"))
                } else {
                    onError(json.optString("message", "Erreur d'activation"))
                }
            }
        })
    }

    // ──────────────────────────────────────────
    //  Validation à chaque démarrage du streaming
    // ──────────────────────────────────────────

    fun validateLicense(
        onValid:   () -> Unit,
        onInvalid: (String) -> Unit,
    ) {
        val key = getLicenseKey()
        if (key == null) {
            onInvalid("Aucune licence activée.")
            return
        }

        // Validation locale (cache 24h)
        val lastValidated = prefs.getLong("last_validated_at", 0L)
        val cacheValid    = System.currentTimeMillis() - lastValidated < 24 * 60 * 60 * 1000L
        if (cacheValid) {
            onValid()
            return
        }

        // Validation distante
        val body = JSONObject().apply {
            put("licenseKey",        key)
            put("deviceFingerprint", getDeviceFingerprint())
        }.toString()

        val request = Request.Builder()
            .url("${PairingManager.getInstance(context).getServerUrl()}/api/license/validate")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // Si pas de réseau, utiliser le cache (mode offline 24h)
                if (cacheValid) onValid() else onInvalid("Pas de connexion et cache expiré.")
            }

            override fun onResponse(call: Call, response: Response) {
                val json = JSONObject(response.body!!.string())
                if (json.optBoolean("valid")) {
                    prefs.edit().putLong("last_validated_at", System.currentTimeMillis()).apply()
                    onValid()
                } else {
                    onInvalid(json.optString("message", "Licence invalide."))
                }
            }
        })
    }

    // ──────────────────────────────────────────
    //  Utilitaires
    // ──────────────────────────────────────────

    fun getLicenseKey(): String? = prefs.getString("license_key", null)

    fun isActivated(): Boolean = getLicenseKey() != null

    fun getDeviceFingerprint(): String {
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        val raw = "$androidId|${android.os.Build.MODEL}|${android.os.Build.MANUFACTURER}"
        return MessageDigest.getInstance("SHA-256")
            .digest(raw.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }

    fun getDeviceName(): String =
        "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"

    fun clearLicense() {
        prefs.edit().clear().apply()
    }
}
