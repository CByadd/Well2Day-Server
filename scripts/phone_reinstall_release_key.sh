#!/data/data/com.termux/files/usr/bin/sh
# One-time move of a kiosk box from the old debug-signed app to the release-key build, run FROM A PHONE.
# Same procedure as APK Root/reinstall_release_key.ps1 (update_system_app.ps1 -Reinstall).
#
# On the phone: install Termux (F-Droid), open it, paste this one line, type the box IP when asked:
#   sh -c "$(curl -fsSL https://api.well2day.in/api/app-release/phone.sh)"
# The FIRST time, the box shows "Allow USB debugging?" for the phone: tick "Always allow" and tap Allow ON THE BOX.
#
# It installs the tools it needs, downloads the published release APK from the server (Admin -> App updates)
# and checks its SHA-256 and signing key. Optional: sh phone.sh <box-ip>
# Keeps app data (Screen ID). Reboots the box. A box already on that version or newer is never touched.
set -u

API=${API:-https://api.well2day.in/api}
PKG=com.example.playerapp.f3.f1
RELEASE_CERT=82d9641a296ac155978894ed70f0cbe4ab5b50466f725d530c30c9cef78dcc2e   # well2day-release.jks
SYS_DIR=/system/priv-app/PlayerApp
SYS_APK=$SYS_DIR/PlayerApp.apk
SYS_XML=/system/etc/permissions/privapp-permissions-playerapp.xml
MAGISK_SYS=/data/adb/modules/playerapp_privapp/system
TMP=/data/local/tmp

step() { echo "[+] $*"; }
fail() { echo "[X] $*"; exit 1; }

# ── 0. Tools (Termux installs them on first run) ───────────────────────────────
need=""
for t in adb:android-tools unzip:unzip openssl:openssl-tool curl:curl; do
    command -v "${t%%:*}" >/dev/null || need="$need ${t#*:}"
done
if [ -n "$need" ]; then
    command -v pkg >/dev/null || fail "Missing tools:$need"
    step "Installing:$need (first run only)..."
    pkg install -y $need >/dev/null 2>&1 || fail "pkg install$need failed - check the phone's internet."
fi

DEV=${1:-}
if [ -z "$DEV" ]; then printf "Box IP (e.g. 10.22.210.139): "; read -r DEV; fi
[ -n "$DEV" ] || fail "No box IP given."
case $DEV in *:*) ;; *) DEV=$DEV:5555 ;; esac

# ── 1. The release published on the server (Admin -> App updates) ─────────────
j=$(curl -fsSL "$API/app-release/latest?package=$PKG") || fail "Can't reach $API (no internet?)."
url=$(echo "$j" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
want=$(echo "$j" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
name=$(echo "$j" | sed -n 's/.*"versionName":"\([^"]*\)".*/\1/p')
CODE=$(echo "$j" | sed -n 's/.*"versionCode":\([0-9]*\).*/\1/p')
[ -n "$url" ] && [ -n "$CODE" ] || fail "No release published for all screens. Publish one in Admin -> App updates (leave Screen IDs empty)."
step "Published release: v$name (code $CODE)"

# ── 2. Connect ─────────────────────────────────────────────────────────────────
A() { adb -s "$DEV" "$@"; }
connect() { adb connect "$DEV" >/dev/null 2>&1; [ "$(A get-state 2>/dev/null)" = device ]; }
i=0; until connect; do i=$((i+1)); [ $i -ge 5 ] && fail "Box $DEV not reachable (or USB debugging not allowed for this phone - check the box screen)."; sleep 2; done
step "Connected: $DEV"

info() { A shell dumpsys package $PKG 2>/dev/null; }
# Screen ID = files/machine_id.txt (losing app data re-registers the kiosk as a NEW screen). Tries su, run-as, adb root.
screen_id() {
    for c in "su -c 'cat /data/data/$PKG/files/machine_id.txt'" "run-as $PKG cat files/machine_id.txt" "cat /data/data/$PKG/files/machine_id.txt"; do
        id=$(A shell "$c" 2>/dev/null | tr -d '\r' | grep -oE '^[0-9]{8}' | head -n1)
        [ -n "$id" ] && { echo "$id"; return; }
    done
}
BEFORE_CODE=$(info | grep -o 'versionCode=[0-9]*' | head -n1 | cut -d= -f2)
SCREEN_ID=$(screen_id)
echo "    installed code=${BEFORE_CODE:-none} screenId=${SCREEN_ID:-?}"


# Never touch a box already on this version or newer: reinstalling an older /system copy over a newer
# update is a DOWNGRADE, and Android then wipes the app data (the box gets a new Screen ID).
if [ -z "$BEFORE_CODE" ]; then fail "Can't read the installed version on the box - not touching it."; fi
if [ "$BEFORE_CODE" -ge "$CODE" ]; then
    echo "[=] Box already has code $BEFORE_CODE (>= $CODE). Nothing to do - it updates itself over the air."; exit 0
fi

step "Downloading v$name..."
APK=$(mktemp -d)/w2d_release.apk
curl -fL --progress-bar -o "$APK" "$url" || fail "Download failed: $url"
[ "$(sha256sum "$APK" | cut -d' ' -f1)" = "$want" ] || fail "Downloaded APK is corrupt (SHA-256 mismatch). Run again."
cert=$(unzip -p "$APK" 'META-INF/*.RSA' 2>/dev/null | openssl pkcs7 -inform DER -print_certs 2>/dev/null |
    openssl x509 -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
[ "$cert" = "$RELEASE_CERT" ] || fail "The published APK is NOT signed with the Well2Day release key (cert $cert)."
step "APK signed with the release key - OK"
LOCAL_SHA=$want

# ── 3. Root ────────────────────────────────────────────────────────────────────
USE_SU=0
get_root() {
    A root >/dev/null 2>&1; sleep 3; connect
    if [ "$(A shell id -u 2>/dev/null | tr -d '\r')" = 0 ]; then USE_SU=0; return 0; fi
    if [ "$(A shell "su -c 'id -u'" 2>/dev/null | tr -d '\r')" = 0 ]; then USE_SU=1; return 0; fi
    fail "No root on the box (neither adb root nor su)."
}
R() { if [ $USE_SU = 1 ]; then A shell "su -c '$1'"; else A shell "$1"; fi; }   # $1 must not contain single quotes
wait_boot() {
    step "Waiting for the box to boot..."
    i=0; while [ $i -lt 90 ]; do
        sleep 2; i=$((i+1)); connect 2>/dev/null || continue
        [ "$(A shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && { sleep 5; return 0; }
    done
    fail "Box did not come back within 3 minutes."
}
step "Getting root..."
get_root

# ── 4. Make /system writable ───────────────────────────────────────────────────
step "Making /system writable..."
for attempt in 1 2; do
    if [ $USE_SU = 1 ]; then R "mount -o remount,rw /system 2>/dev/null || mount -o remount,rw /" >/dev/null 2>&1
    else
        out=$(A remount 2>&1)
        case $out in *reboot*)   # first remount after disabling dm-verity needs one reboot
            step "Verity disabled; rebooting once to finish remount..."; A reboot >/dev/null 2>&1; wait_boot; get_root; continue ;;
        esac
    fi
    R "touch /system/.w2d && rm /system/.w2d && echo RW" 2>/dev/null | grep -q RW && break
    [ $attempt = 2 ] && fail "/system is still read-only."
done

# ── 5. Push + replace the /system copy ─────────────────────────────────────────
step "Pushing APK + permission whitelist..."
WORK=$(mktemp -d) || fail "mktemp failed"
cat > "$WORK/perms.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<permissions>
    <privapp-permissions package="com.example.playerapp.f3.f1">
        <permission name="android.permission.MANAGE_USB" />
    </privapp-permissions>
    <privapp-permissions package="com.example.playerapp.f3.normal">
        <permission name="android.permission.MANAGE_USB" />
    </privapp-permissions>
    <privapp-permissions package="com.example.playerapp.f3.f2">
        <permission name="android.permission.MANAGE_USB" />
    </privapp-permissions>
    <privapp-permissions package="com.example.playerapp">
        <permission name="android.permission.MANAGE_USB" />
    </privapp-permissions>
</permissions>
EOF
# Copy to .new then mv: a half-written APK in /system bootloops the app; a rename can't be half-done.
# Stale oat/ (odex of the OLD apk) is removed so ART recompiles instead of crashing.
cat > "$WORK/install.sh" <<EOF
set -e
mkdir -p $SYS_DIR
cp $TMP/w2d_PlayerApp.apk $SYS_DIR/PlayerApp.apk.new
chmod 644 $SYS_DIR/PlayerApp.apk.new
mv -f $SYS_DIR/PlayerApp.apk.new $SYS_APK
rm -rf $SYS_DIR/oat
chmod 755 $SYS_DIR
chown -R root:root $SYS_DIR
cp $TMP/w2d_perms.xml $SYS_XML
chmod 644 $SYS_XML
restorecon -R $SYS_DIR $SYS_XML 2>/dev/null || chcon -R u:object_r:system_file:s0 $SYS_DIR $SYS_XML
if [ -d $MAGISK_SYS ]; then cp $TMP/w2d_PlayerApp.apk $MAGISK_SYS/priv-app/PlayerApp/PlayerApp.apk; cp $TMP/w2d_perms.xml $MAGISK_SYS/etc/permissions/privapp-permissions-playerapp.xml; chmod 644 $MAGISK_SYS/priv-app/PlayerApp/PlayerApp.apk; fi
sync
sha256sum $SYS_APK
EOF
A push "$APK" $TMP/w2d_PlayerApp.apk >/dev/null || fail "push APK failed"
A push "$WORK/perms.xml" $TMP/w2d_perms.xml >/dev/null || fail "push XML failed"
A push "$WORK/install.sh" $TMP/w2d_install.sh >/dev/null || fail "push script failed"
rm -rf "$WORK"

step "Writing $SYS_APK..."
res=$(R "sh $TMP/w2d_install.sh" 2>&1)
echo "$res" | grep -q "$LOCAL_SHA" || fail "SHA-256 mismatch after copy - /system APK is not the one you pushed. Output: $res"

# Drop the old debug-signed /data update so it can't shadow the new system copy. Keeps app data.
A shell pm uninstall-system-updates $PKG >/dev/null 2>&1
A shell rm -f $TMP/w2d_PlayerApp.apk $TMP/w2d_perms.xml $TMP/w2d_install.sh >/dev/null 2>&1

step "Rebooting to register the system copy..."
A reboot >/dev/null 2>&1
wait_boot

# ── 6. Verify ──────────────────────────────────────────────────────────────────
d=$(info)
AFTER_CODE=$(echo "$d" | grep -o 'versionCode=[0-9]*' | head -n1 | cut -d= -f2)
NEW_PATH=$(A shell pm path $PKG 2>/dev/null | tr -d '\r' | sed -n 's/^package://p' | head -n1)
[ "$NEW_PATH" = "$SYS_APK" ] || fail "After reboot the app runs from $NEW_PATH, expected $SYS_APK."
echo "$d" | grep -q 'pkgFlags=\[[^]]*SYSTEM' || fail "After reboot the app is not a system app."
echo "$d" | grep -q 'MANAGE_USB: granted=true' || echo "[!] MANAGE_USB not granted - USB sensor will need the consent dialog."
NEW_ID=$(screen_id)
[ -n "$SCREEN_ID" ] && [ "$NEW_ID" != "$SCREEN_ID" ] && echo "[!] Screen ID changed $SCREEN_ID -> $NEW_ID (app data was lost)."

A shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "===================================================="
echo " OK: $PKG code ${BEFORE_CODE:-none} -> $AFTER_CODE, system app, screenId=${NEW_ID:-?}"
echo " From now on this box updates itself over the air."
echo "===================================================="
