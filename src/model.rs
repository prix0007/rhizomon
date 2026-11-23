//! Core domain types shared by every module. Serializable for the JSON API.

use std::collections::BTreeMap;
use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

/// A 48-bit MAC address. Serialized as lowercase, zero-padded `aa:bb:cc:dd:ee:ff`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct MacAddr(pub [u8; 6]);

impl Serialize for MacAddr {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for MacAddr {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Gateway,
    ThisMachine,
    Printer,
    Tv,
    Speaker,
    Phone,
    Computer,
    NetworkGear,
    Iot,
    #[default]
    Unknown,
}

impl DeviceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gateway => "gateway",
            Self::ThisMachine => "this_machine",
            Self::Printer => "printer",
            Self::Tv => "tv",
            Self::Speaker => "speaker",
            Self::Phone => "phone",
            Self::Computer => "computer",
            Self::NetworkGear => "network_gear",
            Self::Iot => "iot",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "gateway" => Self::Gateway,
            "this_machine" => Self::ThisMachine,
            "printer" => Self::Printer,
            "tv" => Self::Tv,
            "speaker" => Self::Speaker,
            "phone" => Self::Phone,
            "computer" => Self::Computer,
            "network_gear" => Self::NetworkGear,
            "iot" => Self::Iot,
            _ => Self::Unknown,
        }
    }
}

/// One device on the LAN, as shown in the UI. Times are unix milliseconds.
///
/// `last_seen` is the last time positive liveness evidence was observed
/// (the plan's `last_alive`; the two fields were folded into one).
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub mac: MacAddr,
    pub ip: Ipv4Addr,
    pub vendor: Option<String>,
    pub hostname: Option<String>,
    pub hostname_source: Option<String>,
    pub kind: DeviceKind,
    pub services: Vec<String>,
    pub ssdp_server: Option<String>,
    /// Distinct SSDP search targets seen for this host (e.g. `urn:...:MediaRenderer:1`).
    pub ssdp_types: Vec<String>,
    /// SSDP LOCATION, kept as text only and never fetched.
    pub ssdp_location: Option<String>,
    pub is_gateway: bool,
    pub is_self: bool,
    pub randomized_mac: bool,
    pub shared_mac: bool,
    pub online: bool,
    pub first_seen: i64,
    pub last_seen: i64,
    pub is_new: bool,
    /// Set by the user, never by the network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
    /// Set by the user, never by the network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// From the UPnP device description, else mDNS TXT records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friendly_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PTR answer from the gateway's DNS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns_name: Option<String>,
    /// NetBIOS workstation name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub netbios_name: Option<String>,
    /// Latest ping round-trip time in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<f64>,
    /// Coarse OS family guessed from the ping reply TTL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_hint: Option<String>,
    /// Which of the three identity fields above came only from mDNS TXT records.
    /// mdns-sd does not expose the packet's source address, so those cannot be
    /// tied to the host that sent them: they are shown, but never trusted for
    /// classification and never stored.
    #[serde(skip)]
    pub txt_sourced: TxtSourced,
}

/// See `Device::txt_sourced`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TxtSourced {
    pub friendly_name: bool,
    pub model: bool,
    pub manufacturer: bool,
}

impl Device {
    /// A device seen for the first time at `now`, with nothing known about it.
    pub fn new(mac: MacAddr, ip: Ipv4Addr, now: i64) -> Self {
        Self {
            id: mac.to_string(),
            mac,
            ip,
            vendor: None,
            hostname: None,
            hostname_source: None,
            kind: DeviceKind::Unknown,
            services: vec![],
            ssdp_server: None,
            ssdp_types: vec![],
            ssdp_location: None,
            is_gateway: false,
            is_self: false,
            randomized_mac: false,
            shared_mac: false,
            online: false,
            first_seen: now,
            last_seen: now,
            is_new: false,
            custom_name: None,
            notes: None,
            friendly_name: None,
            manufacturer: None,
            model: None,
            dns_name: None,
            netbios_name: None,
            rtt_ms: None,
            os_hint: None,
            txt_sourced: TxtSourced::default(),
        }
    }
}

/// What the user typed for a device (kept apart from anything learned from the network).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct UserMeta {
    pub custom_name: Option<String>,
    pub notes: Option<String>,
}

pub type DeviceMap = BTreeMap<String, Device>;

/// Per-cycle status pushed to clients and served at `/api/status`.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize, Default)]
pub struct ScanStatus {
    pub scan_started_at: i64,
    pub scan_finished_at: i64,
    pub devices: usize,
    pub online: usize,
    pub iface: String,
    pub net: String,
    pub gateway: Option<String>,
    pub interval_s: u64,
    pub ping_method: String,
    pub mdns_available: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, PartialEq, Debug)]
pub enum DeviceEvent {
    Upsert(Box<Device>),
    Removed(String),
    Scan(Box<ScanStatus>),
}

/// One mDNS observation about an IPv4 host.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct MdnsHit {
    pub ip: std::net::Ipv4Addr,
    pub hostname: Option<String>,
    /// Service labels such as `_ipp` (no `._tcp.local.` suffix).
    pub service_types: Vec<String>,
    /// Observed within the current scan window (counts as liveness); cached
    /// older entries only enrich hostname and services.
    pub fresh: bool,
    /// From TXT records (`fn`, `md`, `model`, `ty`, `am`, ...) or the instance name.
    pub friendly_name: Option<String>,
    pub model: Option<String>,
    pub manufacturer: Option<String>,
}

impl Default for MdnsHit {
    fn default() -> Self {
        Self {
            ip: std::net::Ipv4Addr::UNSPECIFIED,
            hostname: None,
            service_types: vec![],
            fresh: false,
            friendly_name: None,
            model: None,
            manufacturer: None,
        }
    }
}

/// Extra facts about one host, gathered by the optional enrichment sources.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct HostInfo {
    pub friendly_name: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub dns_name: Option<String>,
    pub netbios_name: Option<String>,
    /// Round-trip time of this scan's ping reply, in milliseconds.
    pub rtt_ms: Option<f64>,
    pub os_hint: Option<String>,
    /// A UPnP description was fetched this scan: its three fields replace the
    /// stored ones exactly (a field it no longer has is dropped).
    pub upnp_answered: bool,
    /// A completed query for a host that answered ping found no such name: drop it.
    pub dns_cleared: bool,
    pub netbios_cleared: bool,
}

/// The interesting headers of one SSDP response.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SsdpHit {
    pub server: Option<String>,
    pub st: Option<String>,
    pub usn: Option<String>,
    pub location: Option<String>,
}

/// An SSDP response together with the address it came from.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SsdpObservation {
    pub ip: std::net::Ipv4Addr,
    pub hit: SsdpHit,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_KINDS: [DeviceKind; 10] = [
        DeviceKind::Gateway,
        DeviceKind::ThisMachine,
        DeviceKind::Printer,
        DeviceKind::Tv,
        DeviceKind::Speaker,
        DeviceKind::Phone,
        DeviceKind::Computer,
        DeviceKind::NetworkGear,
        DeviceKind::Iot,
        DeviceKind::Unknown,
    ];

    #[test]
    fn mac_serializes_as_padded_lowercase_string() {
        let m = MacAddr([0, 0x1a, 0x2b, 3, 4, 5]);
        assert_eq!(serde_json::to_string(&m).unwrap(), "\"00:1a:2b:03:04:05\"");
        let m = MacAddr([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
        assert_eq!(serde_json::to_string(&m).unwrap(), "\"aa:bb:cc:dd:ee:ff\"");
        assert_eq!(serde_json::to_string(&m).unwrap(), format!("\"{m}\""));
    }

    #[test]
    fn mac_serde_round_trip() {
        for m in [
            MacAddr([0; 6]),
            MacAddr([0xff; 6]),
            MacAddr([0x68, 0x7f, 0xf0, 0x00, 0x0a, 0x01]),
        ] {
            let j = serde_json::to_string(&m).unwrap();
            assert_eq!(serde_json::from_str::<MacAddr>(&j).unwrap(), m);
        }
        let m: MacAddr = serde_json::from_str("\"0:1a:2b:3:4:5\"").unwrap();
        assert_eq!(m, MacAddr([0, 0x1a, 0x2b, 3, 4, 5]));
        let m: MacAddr = serde_json::from_str("\"AA-BB-CC-DD-EE-FF\"").unwrap();
        assert_eq!(m, MacAddr([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
    }

    #[test]
    fn mac_deserialize_rejects_malformed() {
        for bad in [
            "",
            "aa:bb:cc:dd:ee",
            "aa:bb:cc:dd:ee:ff:00",
            "aa:bb:cc:dd:ee:gg",
            "aaa:bb:cc:dd:ee:ff",
            "::::::",
            "aa:bb:cc:dd:ee:",
        ] {
            let j = serde_json::to_string(bad).unwrap();
            let err = serde_json::from_str::<MacAddr>(&j).unwrap_err();
            assert!(
                err.to_string().contains("invalid MAC address"),
                "{bad:?} should be rejected as an invalid MAC, got {err}"
            );
        }
        for bad in ["123", "null", "[0,1,2,3,4,5]"] {
            assert!(
                serde_json::from_str::<MacAddr>(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn device_kind_as_str_from_db_round_trip() {
        for k in ALL_KINDS {
            assert_eq!(DeviceKind::from_db(k.as_str()), k);
        }
        let names: std::collections::BTreeSet<_> = ALL_KINDS.iter().map(|k| k.as_str()).collect();
        assert_eq!(names.len(), ALL_KINDS.len());
    }

    #[test]
    fn device_kind_from_db_unknown_values_fall_back() {
        for s in ["", "router", "Gateway", "this-machine", " tv", "unknown"] {
            assert_eq!(DeviceKind::from_db(s), DeviceKind::Unknown, "{s:?}");
        }
        assert_eq!(DeviceKind::default(), DeviceKind::Unknown);
    }

    #[test]
    fn device_kind_serde_matches_as_str() {
        for k in ALL_KINDS {
            assert_eq!(
                serde_json::to_string(&k).unwrap(),
                format!("\"{}\"", k.as_str())
            );
        }
    }
}
