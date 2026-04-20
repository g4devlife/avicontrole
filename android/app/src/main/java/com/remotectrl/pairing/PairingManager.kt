package com.remotectrl.pairing

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

class PairingManager private constructor(private val context: Context) {

    companion object {
        // URL du serveur de production — même pour tous les APKs
        const val SERVER_URL = "https://api.avicontrole.app"

        @Volatile private var INSTANCE: PairingManager? = null
        fun getInstance(ctx: Context): PairingManager =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: PairingManager(ctx.applicationContext).also { INSTANCE = it }
            }
    }

    private var _prefs: android.content.SharedPreferences? = null
    private val prefs: android.content.SharedPreferences
        get() {
            if (_prefs == null) {
                _prefs = createPrefs()
            }
            return _prefs!!
        }

    private fun createPrefs(): android.content.SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            "pairing_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val http = OkHttpClient()

    // ── Vérifier le code à 5 chiffres et associer au PC ──────────
    fun verifyCode(
        code:      String,
        onSuccess: (pcAccountId: String) -> Unit,
        onError:   (message: String) -> Unit,
    ) {
        val body = JSONObject().apply {
            put("pairingCode", code.trim())
        }.toString()

        val request = Request.Builder()
            .url("$SERVER_URL/api/pair/verify")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onError("Erreur réseau : ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                val text = response.body?.string() ?: ""
                val json = runCatching { JSONObject(text) }.getOrNull()

                if (response.isSuccessful && json?.optBoolean("ok") == true) {
                    val pcAccountId = json.optString("pcAccountId")
                    // Sauvegarder de façon permanente et chiffrée
                    prefs.edit()
                        .putString("pc_account_id", pcAccountId)
                        .apply()
                    onSuccess(pcAccountId)
                } else {
                    val msg = json?.optString("error") ?: "Code invalide"
                    onError(msg)
                }
            }
        })
    }

    fun getPcAccountId(): String? = prefs.getString("pc_account_id", null)

    fun getServerUrl(): String = SERVER_URL

    fun isPaired(): Boolean = getPcAccountId() != null

    fun clearPairing() {
        prefs.edit().clear().apply()
    }
}
