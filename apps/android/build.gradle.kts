plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Opt-in device fixtures can coexist with the daily app and other test runs.
val deviceTestApplicationIdSuffix = providers.gradleProperty("deviceTestApplicationIdSuffix").orNull
val magpieSigningVariables = listOf(
    "MAGPIE_KEYSTORE_PATH",
    "MAGPIE_KEYSTORE_PASSWORD",
    "MAGPIE_KEY_ALIAS",
    "MAGPIE_KEY_PASSWORD",
)
val magpieSigningValues = magpieSigningVariables.associateWith { providers.environmentVariable(it).orNull }
val magpieMissingSigningVariables = magpieSigningValues.filterValues { it.isNullOrBlank() }.keys
val magpieRequireSigning = providers.environmentVariable("MAGPIE_REQUIRE_SIGNING").orNull == "1"
val magpieSigningConfigured = magpieMissingSigningVariables.isEmpty()

require(!magpieRequireSigning || magpieSigningConfigured) {
    "Magpie distribution signing requires: ${magpieMissingSigningVariables.joinToString()}"
}
require(magpieMissingSigningVariables.size == magpieSigningVariables.size || magpieSigningConfigured) {
    "Incomplete Magpie signing configuration; missing: ${magpieMissingSigningVariables.joinToString()}"
}

val magpieVersionCode = providers.environmentVariable("MAGPIE_VERSION_CODE").orNull?.let { value ->
    require(value.toIntOrNull()?.let { it > 0 } == true) {
        "MAGPIE_VERSION_CODE must be a positive integer"
    }
    value.toInt()
}

android {
    namespace = "com.example.claudephonemonitor"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.example.claudephonemonitor"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.2.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
    }

    buildTypes {
        debug {
            deviceTestApplicationIdSuffix?.let { applicationIdSuffix = it }
        }
        create("magpie") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".magpie"
            versionNameSuffix = "-magpie"
            matchingFallbacks += listOf("debug")
            if (magpieSigningConfigured) {
                signingConfig = signingConfigs.create("magpie") {
                    storeFile = file(requireNotNull(magpieSigningValues["MAGPIE_KEYSTORE_PATH"]))
                    storePassword = magpieSigningValues["MAGPIE_KEYSTORE_PASSWORD"]
                    keyAlias = magpieSigningValues["MAGPIE_KEY_ALIAS"]
                    keyPassword = magpieSigningValues["MAGPIE_KEY_PASSWORD"]
                }
            }
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

androidComponents {
    onVariants(selector().withBuildType("magpie")) { variant ->
        magpieVersionCode?.let { code ->
            variant.outputs.forEach { it.versionCode.set(code) }
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
