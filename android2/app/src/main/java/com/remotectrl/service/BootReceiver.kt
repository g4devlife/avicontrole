package com.remotectrl.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.remotectrl.ui.MainActivity

/**
 * Reçoit l'événement de démarrage du téléphone (Reboot).
 * Relance l'activité principale pour que l'utilisateur puisse re-valider la capture d'écran.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED || 
            action == "android.intent.action.QUICKBOOT_POWERON" || 
            action == "com.htc.intent.action.QUICKBOOT_POWERON") {
            
            val i = Intent(context, MainActivity::class.java)
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
        }
    }
}
