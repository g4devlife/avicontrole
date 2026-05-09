package com.remotectrl.utils

import android.util.Base64

object SecurityUtils {
    // Une clé simple pour XOR (peut être changée)
    private const val MASK = 0xAF.toByte()

    /**
     * "Déchiffre" une chaîne de caractères encodée
     */
    fun decode(encoded: String): String {
        val data = Base64.decode(encoded, Base64.DEFAULT)
        val decoded = ByteArray(data.size)
        for (i in data.indices) {
            decoded[i] = (data[i].toInt() xor MASK.toInt()).toByte()
        }
        return String(decoded)
    }

    /**
     * Utilitaire pour générer la chaîne encodée (à utiliser pendant le dev)
     */
    fun encode(input: String): String {
        val data = input.toByteArray()
        val encoded = ByteArray(data.size)
        for (i in data.indices) {
            encoded[i] = (data[i].toInt() xor MASK.toInt()).toByte()
        }
        return Base64.encodeToString(encoded, Base64.DEFAULT)
    }
}
