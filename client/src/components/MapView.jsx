import { useEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { DEFAULT_CENTER } from '../util.js';
import { VEHICLE_ICON } from '../ds/icons.jsx';
import { WaterlogMarkers } from './Waterlog.jsx';

// divIcons are plain HTML: they sidestep Leaflet's default PNG markers (which
// break under bundlers) and follow the CSS theme.
const pin = (kind) => L.divIcon({ className: '', html: `<div class="pin pin-${kind}"><span></span></div>`, iconSize: [28, 36], iconAnchor: [14, 34] });
const ICONS = { pickup: pin('pickup'), drop: pin('drop'), stop: pin('stop') };
const vehicleIcons = Object.fromEntries(
  Object.entries(VEHICLE_ICON).map(([type, Icon]) => [
    type,
    L.divIcon({ className: 'vehicle-moving', html: `<div class="vehicle-pin">${renderToStaticMarkup(<Icon size={22} aria-hidden />)}</div>`, iconSize: [40, 40], iconAnchor: [20, 20] }),
  ]),
);
const meIcon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });

function ClickCatcher({ onClick }) {
  useMapEvents({ click: (e) => onClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

/**
 * Re-frames the map when `fitKey` changes - not on every vehicle tick. `padBottom` is how much
 * of the map a bottom sheet covers, so the points land in the part you can see.
 */
function Framer({ points, fitKey, padBottom = 0 }) {
  const map = useMap();
  useEffect(() => {
    const valid = points.filter(Boolean);
    if (!valid.length) return;
    if (valid.length === 1) {
      const zoom = Math.max(map.getZoom(), 15);
      const centre = map.unproject(map.project([valid[0].lat, valid[0].lng], zoom).add([0, padBottom / 2]), zoom);
      map.flyTo(centre, zoom, { duration: 0.6 });
    } else {
      map.flyToBounds(L.latLngBounds(valid.map((p) => [p.lat, p.lng])), { paddingTopLeft: [40, 72], paddingBottomRight: [40, padBottom + 40], maxZoom: 16, duration: 0.6 });
    }
  }, [fitKey, padBottom]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Leaflet measures its container once; tell it whenever the layout around it changes. */
function SizeWatcher() {
  const map = useMap();
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function MapView({ pickup, stops = [], dropoff, route, approach, vehicle, vehicleType = 'car', me, onMapClick, fitKey, fitPoints, padBottom = 0, showWaterlog = false, className = '' }) {
  const center = pickup ?? me ?? vehicle ?? DEFAULT_CENTER;
  const framePoints = fitPoints ?? [pickup, ...stops, dropoff];
  const key = fitKey ?? framePoints.map((p) => (p ? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : '-')).join('|');

  return (
    <MapContainer center={[center.lat, center.lng]} zoom={14} zoomControl={false} className={`h-full w-full ${className}`}>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
      />
      <SizeWatcher />
      <ClickCatcher onClick={onMapClick} />
      <Framer points={framePoints} fitKey={key} padBottom={padBottom} />

      {route?.length > 1 && (
        <>
          <Polyline positions={route} pathOptions={{ className: 'route-casing', weight: 9 }} />
          <Polyline positions={route} pathOptions={{ className: 'route-line', weight: 5 }} />
        </>
      )}
      {approach?.length > 1 && <Polyline positions={approach} pathOptions={{ className: 'route-approach', weight: 4, dashArray: '2 8' }} />}

      {pickup && (
        <Marker position={[pickup.lat, pickup.lng]} icon={ICONS.pickup}>
          <Tooltip direction="top" offset={[0, -30]}>Pickup</Tooltip>
        </Marker>
      )}
      {stops.map((s, i) => (
        <Marker key={i} position={[s.lat, s.lng]} icon={ICONS.stop}>
          <Tooltip direction="top" offset={[0, -30]}>Stop {i + 1}</Tooltip>
        </Marker>
      ))}
      {dropoff && (
        <Marker position={[dropoff.lat, dropoff.lng]} icon={ICONS.drop}>
          <Tooltip direction="top" offset={[0, -30]}>Drop</Tooltip>
        </Marker>
      )}
      {showWaterlog && <WaterlogMarkers />}
      {me && <Marker position={[me.lat, me.lng]} icon={meIcon} />}
      {vehicle && <Marker position={[vehicle.lat, vehicle.lng]} icon={vehicleIcons[vehicleType] ?? vehicleIcons.car} zIndexOffset={1000} />}
    </MapContainer>
  );
}
