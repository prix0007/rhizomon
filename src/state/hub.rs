//! Shared live state: current snapshot plus a broadcast channel of changes.

use std::collections::BTreeMap;
use std::sync::RwLock;

use tokio::sync::broadcast;

use crate::model::{Device, DeviceEvent, DeviceMap, ScanStatus, UserMeta};

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub devices: Vec<Device>,
    pub status: Option<ScanStatus>,
}

pub struct Hub {
    inner: RwLock<(DeviceMap, Option<ScanStatus>)>,
    /// The user's names and notes, the single source of truth for those two
    /// fields: whatever the scanner publishes is overlaid with these. (Lock
    /// order: `inner` before `meta`.)
    meta: RwLock<BTreeMap<String, UserMeta>>,
    /// Identity of the network being shown (set by the scanner once observed).
    network: RwLock<Option<String>>,
    tx: broadcast::Sender<DeviceEvent>,
}

fn overlay(d: &mut Device, meta: &BTreeMap<String, UserMeta>) {
    if let Some(u) = meta.get(&d.id) {
        d.custom_name = u.custom_name.clone();
        d.notes = u.notes.clone();
    }
}

impl Hub {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(1));
        Self {
            inner: RwLock::new((DeviceMap::new(), None)),
            meta: RwLock::new(BTreeMap::new()),
            network: RwLock::new(None),
            tx,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let g = self.inner.read().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            devices: g.0.values().cloned().collect(),
            status: g.1.clone(),
        }
    }

    /// The current device map, i.e. what a client that is up to date knows.
    pub fn device_map(&self) -> DeviceMap {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .clone()
    }

    pub fn set_network_id(&self, id: Option<String>) {
        *self.network.write().unwrap_or_else(|e| e.into_inner()) = id;
    }

    pub fn network_id(&self) -> Option<String> {
        self.network
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn user_meta_snapshot(&self) -> BTreeMap<String, UserMeta> {
        self.meta.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Replace all user metadata (e.g. when history for a network is loaded).
    pub fn load_user_meta(&self, meta: BTreeMap<String, UserMeta>) {
        *self.meta.write().unwrap_or_else(|e| e.into_inner()) = meta;
    }

    /// Record the user's name/notes for a known device, update the snapshot and
    /// broadcast the change. `None` if the device is not known.
    pub fn commit_user_meta(&self, id: &str, new: UserMeta) -> Option<Device> {
        let updated = {
            let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
            let d = g.0.get_mut(id)?;
            d.custom_name = new.custom_name.clone();
            d.notes = new.notes.clone();
            let updated = d.clone();
            self.meta
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.to_string(), new);
            updated
        };
        let _ = self.tx.send(DeviceEvent::Upsert(Box::new(updated.clone())));
        Some(updated)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DeviceEvent> {
        self.tx.subscribe()
    }

    /// Apply one event to the snapshot and broadcast it.
    pub fn publish(&self, mut event: DeviceEvent) {
        {
            let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
            let meta = self.meta.read().unwrap_or_else(|e| e.into_inner());
            match &mut event {
                DeviceEvent::Upsert(d) => {
                    overlay(d, &meta);
                    g.0.insert(d.id.clone(), (**d).clone());
                }
                DeviceEvent::Removed(id) => {
                    g.0.remove(id);
                }
                DeviceEvent::Scan(s) => g.1 = Some((**s).clone()),
            }
        }
        // No receivers is fine.
        let _ = self.tx.send(event);
    }

    /// Replace the full device map (so `last_seen` stays fresh in snapshots),
    /// then broadcast the changes and the scan status.
    pub fn apply_scan(&self, devices: &DeviceMap, events: Vec<DeviceEvent>, status: ScanStatus) {
        let events: Vec<DeviceEvent> = {
            let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
            let meta = self.meta.read().unwrap_or_else(|e| e.into_inner());
            let mut map = devices.clone();
            for d in map.values_mut() {
                overlay(d, &meta);
            }
            g.0 = map;
            g.1 = Some(status.clone());
            // Events carry the user's current text too, so a late edit is not undone.
            events
                .into_iter()
                .map(|mut ev| {
                    if let DeviceEvent::Upsert(d) = &mut ev {
                        overlay(d, &meta);
                    }
                    ev
                })
                .collect()
        };
        for ev in events {
            let _ = self.tx.send(ev);
        }
        let _ = self.tx.send(DeviceEvent::Scan(Box::new(status)));
    }

    /// Seed the snapshot (e.g. from history) without broadcasting.
    pub fn seed(&self, devices: &DeviceMap) {
        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let meta = self.meta.read().unwrap_or_else(|e| e.into_inner());
        let mut map = devices.clone();
        for d in map.values_mut() {
            overlay(d, &meta);
        }
        g.0 = map;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast::error::TryRecvError;

    const T0: i64 = 1_700_000_000_000;
    const A: &str = "02:00:00:00:00:0a";
    const B: &str = "02:00:00:00:00:0b";
    const C: &str = "02:00:00:00:00:0c";

    fn dev(mac: &str, ip: &str) -> Device {
        Device::new(mac.parse().unwrap(), ip.parse().unwrap(), T0)
    }

    fn map_of(devices: Vec<Device>) -> DeviceMap {
        devices.into_iter().map(|d| (d.id.clone(), d)).collect()
    }

    fn status(n: usize) -> ScanStatus {
        ScanStatus {
            devices: n,
            ..Default::default()
        }
    }

    fn meta(name: &str, notes: &str) -> UserMeta {
        UserMeta {
            custom_name: Some(name.into()),
            notes: Some(notes.into()),
        }
    }

    fn upsert(d: Device) -> DeviceEvent {
        DeviceEvent::Upsert(Box::new(d))
    }

    fn named(mut d: Device, m: &UserMeta) -> Device {
        d.custom_name = m.custom_name.clone();
        d.notes = m.notes.clone();
        d
    }

    #[test]
    fn new_hub_is_empty() {
        let hub = Hub::new(0);
        let snap = hub.snapshot();
        assert!(snap.devices.is_empty());
        assert_eq!(snap.status, None);
        assert!(hub.device_map().is_empty());
        assert_eq!(hub.network_id(), None);
        assert!(hub.user_meta_snapshot().is_empty());
    }

    #[test]
    fn seed_sets_map_and_snapshot_without_broadcasting() {
        let hub = Hub::new(16);
        let mut rx = hub.subscribe();
        let map = map_of(vec![dev(A, "192.168.0.10"), dev(B, "192.168.0.11")]);
        hub.seed(&map);

        assert_eq!(hub.device_map(), map);
        let snap = hub.snapshot();
        assert_eq!(snap.devices, map.values().cloned().collect::<Vec<_>>());
        assert_eq!(snap.status, None);
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn seed_applies_loaded_user_meta() {
        let hub = Hub::new(16);
        let m = meta("Printer", "upstairs");
        hub.load_user_meta(BTreeMap::from([(A.to_string(), m.clone())]));
        hub.seed(&map_of(vec![
            dev(A, "192.168.0.10"),
            dev(B, "192.168.0.11"),
        ]));

        let map = hub.device_map();
        assert_eq!(map[A], named(dev(A, "192.168.0.10"), &m));
        assert_eq!(map[B].custom_name, None);
        assert_eq!(map[B].notes, None);
    }

    #[test]
    fn apply_scan_replaces_map_and_broadcasts_events_then_status() {
        let hub = Hub::new(16);
        hub.seed(&map_of(vec![
            dev(A, "192.168.0.10"),
            dev(B, "192.168.0.11"),
        ]));
        let mut rx = hub.subscribe();

        let mut a = dev(A, "192.168.0.10");
        a.last_seen = T0 + 1_000;
        let c = dev(C, "192.168.0.12");
        hub.apply_scan(
            &map_of(vec![a.clone(), c.clone()]),
            vec![upsert(c.clone()), DeviceEvent::Removed(B.to_string())],
            status(2),
        );

        let map = hub.device_map();
        assert_eq!(map.keys().cloned().collect::<Vec<_>>(), vec![A, C]);
        assert_eq!(map[A], a);
        let snap = hub.snapshot();
        assert_eq!(snap.devices, vec![a, c.clone()]);
        assert_eq!(snap.status, Some(status(2)));

        assert_eq!(rx.try_recv(), Ok(upsert(c)));
        assert_eq!(rx.try_recv(), Ok(DeviceEvent::Removed(B.to_string())));
        assert_eq!(rx.try_recv(), Ok(DeviceEvent::Scan(Box::new(status(2)))));
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn apply_scan_overlays_user_meta_on_map_and_events() {
        let hub = Hub::new(16);
        let m = meta("Laptop", "work");
        hub.load_user_meta(BTreeMap::from([(A.to_string(), m.clone())]));
        let mut rx = hub.subscribe();

        // The scanner does not know the user's text.
        let a = dev(A, "192.168.0.10");
        hub.apply_scan(&map_of(vec![a.clone()]), vec![upsert(a.clone())], status(1));

        let expected = named(a, &m);
        assert_eq!(hub.device_map()[A], expected);
        assert_eq!(rx.try_recv(), Ok(upsert(expected)));
        assert_eq!(rx.try_recv(), Ok(DeviceEvent::Scan(Box::new(status(1)))));
    }

    #[test]
    fn network_id_set_and_get() {
        let hub = Hub::new(16);
        hub.set_network_id(Some("net-1".into()));
        assert_eq!(hub.network_id(), Some("net-1".into()));
        hub.set_network_id(None);
        assert_eq!(hub.network_id(), None);
    }

    #[test]
    fn load_user_meta_replaces_rather_than_merges() {
        let hub = Hub::new(16);
        hub.load_user_meta(BTreeMap::from([(A.to_string(), meta("a", "x"))]));
        let second = BTreeMap::from([(B.to_string(), meta("b", "y"))]);
        hub.load_user_meta(second.clone());
        assert_eq!(hub.user_meta_snapshot(), second);
    }

    #[test]
    fn commit_user_meta_for_known_device_updates_and_broadcasts() {
        let hub = Hub::new(16);
        hub.seed(&map_of(vec![
            dev(A, "192.168.0.10"),
            dev(B, "192.168.0.11"),
        ]));
        let mut rx = hub.subscribe();

        let m = meta("NAS", "closet");
        let updated = hub.commit_user_meta(A, m.clone());
        let expected = named(dev(A, "192.168.0.10"), &m);

        assert_eq!(updated, Some(expected.clone()));
        assert_eq!(hub.device_map()[A], expected);
        assert_eq!(hub.device_map()[B], dev(B, "192.168.0.11"));
        assert_eq!(
            hub.user_meta_snapshot(),
            BTreeMap::from([(A.to_string(), m)])
        );
        assert_eq!(rx.try_recv(), Ok(upsert(expected)));
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn commit_user_meta_for_unknown_device_changes_nothing() {
        let hub = Hub::new(16);
        let map = map_of(vec![dev(A, "192.168.0.10")]);
        hub.seed(&map);
        let mut rx = hub.subscribe();

        assert_eq!(hub.commit_user_meta(C, meta("ghost", "gone")), None);
        assert_eq!(hub.device_map(), map);
        assert!(hub.user_meta_snapshot().is_empty());
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn publish_reaches_subscribers_and_updates_state() {
        let hub = Hub::new(16);
        let mut rx1 = hub.subscribe();
        let mut rx2 = hub.subscribe();

        let a = dev(A, "192.168.0.10");
        hub.publish(upsert(a.clone()));
        assert_eq!(rx1.try_recv(), Ok(upsert(a.clone())));
        assert_eq!(rx2.try_recv(), Ok(upsert(a.clone())));
        assert_eq!(hub.device_map(), map_of(vec![a]));

        hub.publish(DeviceEvent::Scan(Box::new(status(1))));
        assert_eq!(rx1.try_recv(), Ok(DeviceEvent::Scan(Box::new(status(1)))));
        assert_eq!(hub.snapshot().status, Some(status(1)));

        hub.publish(DeviceEvent::Removed(A.to_string()));
        assert_eq!(rx1.try_recv(), Ok(DeviceEvent::Removed(A.to_string())));
        assert!(hub.device_map().is_empty());
        assert!(hub.snapshot().devices.is_empty());
    }

    #[test]
    fn publish_without_subscribers_still_applies_meta() {
        let hub = Hub::new(16);
        let m = meta("TV", "living room");
        hub.load_user_meta(BTreeMap::from([(A.to_string(), m.clone())]));

        let a = dev(A, "192.168.0.10");
        hub.publish(upsert(a.clone()));
        assert_eq!(hub.device_map()[A], named(a, &m));
    }
}
