// The MyForrest app for Android: the web app in a WebView plus recording in the background
// (GPS track and drive mode with the camera), see docs/android.md.
//
//   ./gradlew assembleDebug                       app/build/outputs/apk/debug/app-debug.apk
//   ./gradlew test                                unit tests (selection like public/drive-select.js)
//   ./gradlew assembleRelease -PmyforrestUrl=https://myforrest.example.org
//
// Server address: property myforrestUrl or variable MYFORREST_URL; without one the app asks on first start.
// Signing a release: variables ANDROID_KEYSTORE (path), ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS,
// ANDROID_KEY_PASSWORD; without them the release build is unsigned.

plugins {
  id("com.android.application")
}

fun setting(property: String, env: String): String =
  (project.findProperty(property) as String?) ?: System.getenv(env) ?: ""

val serverUrl = setting("myforrestUrl", "MYFORREST_URL")
val keystore = System.getenv("ANDROID_KEYSTORE") ?: ""

android {
  namespace = "xyz.myforrest.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "xyz.myforrest.app"
    minSdk = 26
    targetSdk = 35
    versionCode = (setting("versionCode", "ANDROID_VERSION_CODE").ifEmpty { "1" }).toInt()
    versionName = setting("versionName", "ANDROID_VERSION_NAME").ifEmpty { "1.0" }
    buildConfigField("String", "SERVER_URL", "\"${serverUrl.replace("\"", "")}\"")
  }

  buildFeatures {
    buildConfig = true
  }

  signingConfigs {
    if (keystore.isNotEmpty()) {
      create("release") {
        storeFile = file(keystore)
        storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("ANDROID_KEY_ALIAS")
        keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      if (keystore.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  lint {
    // The app talks to self-hosted servers, also in the local network without HTTPS.
    disable += "InsecureBaseConfiguration"
  }
}

dependencies {
  // No libraries in the app itself: WebView, Camera2 and the location service come with Android.
  testImplementation("junit:junit:4.13.2")
  // org.json of android.jar only exists on a device; for the unit tests on the JVM.
  testImplementation("org.json:json:20240303")
}
