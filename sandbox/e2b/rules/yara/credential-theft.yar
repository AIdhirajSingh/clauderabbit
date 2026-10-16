rule cr_credential_paths_with_network
{
    meta:
        severity = "high"
        description = "References several credential stores together with an outbound HTTP or socket call"
    strings:
        $c1 = ".aws/credentials" ascii wide
        $c2 = ".ssh/id_rsa" ascii wide
        $c3 = ".npmrc" ascii wide
        $c4 = ".git-credentials" ascii wide
        $c5 = ".docker/config.json" ascii wide
        $c6 = "Login Data" ascii wide
        $n1 = "https.request" ascii
        $n2 = "XMLHttpRequest" ascii
        $n3 = "urlopen" ascii
        $n4 = "requests.post" ascii
        $n5 = "net.connect" ascii
        $n6 = "fetch(" ascii
    condition:
        filesize < 4MB and 2 of ($c*) and 1 of ($n*)
}

rule cr_discord_or_telegram_exfil
{
    meta:
        severity = "high"
        description = "Posts to a Discord webhook or the Telegram bot API, a common exfiltration channel"
    strings:
        $d = /discord(app)?\.com\/api\/webhooks\/[0-9]+\// ascii
        $t = /api\.telegram\.org\/bot[0-9]+:/ ascii
    condition:
        filesize < 4MB and any of them
}
