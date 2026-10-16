rule cr_long_base64_eval
{
    meta:
        severity = "medium"
        description = "A very long base64 literal next to eval, exec or Function"
    strings:
        $b64 = /[A-Za-z0-9+\/]{800,}={0,2}/ ascii
        $e1 = "eval(" ascii
        $e2 = "exec(" ascii
        $e3 = "Function(" ascii
    condition:
        filesize < 8MB and $b64 and any of ($e*)
}

rule cr_hex_escaped_blob
{
    meta:
        severity = "medium"
        description = "A long run of \\x hex escapes, a common string obfuscation"
    strings:
        $hex = /(\\x[0-9a-fA-F]{2}){200,}/ ascii
    condition:
        filesize < 8MB and $hex
}
