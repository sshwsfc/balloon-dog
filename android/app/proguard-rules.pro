# OkHttp 在 release 下会告警缺少 Conscrypt / BouncyCastle 的可选类，忽略即可
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
