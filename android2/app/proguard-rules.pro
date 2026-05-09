# Obfuscation agressive
-repackageclasses ''
-allowaccessmodification
-overloadaggressively

# Optimisations
-optimizations !code/simplification/arithmetic,!field/*,!class/merging/*
-optimizationpasses 5

# Garder les classes nécessaires pour Android
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Application
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.content.ContentProvider
-keep public class * extends android.app.backup.BackupAgentHelper
-keep public class * extends android.preference.Preference
-keep public class * extends com.google.vending.licensing.ILicensingService

# Garder les membres natifs
-keepclasseswithmembernames class * {
    native <methods>;
}

# Socket.IO et WebRTC nécessitent souvent des exclusions pour la réflexion
-keep class io.socket.** { *; }
-keep class org.webrtc.** { *; }
-keep class org.json.** { *; }

# Ne pas supprimer les attributs pour le debugging (optionnel, mais recommandé pour les crashs)
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
