const SHEET_ID = "1rcKb4GvBBX9XjfYLc-yU3zlcEzZ1fXhC7GWl6-WC-Ro";
const SHEET_GID = "0";
const AMSTERDAM_CENTER = [52.3676, 4.9041];
const USER_LOCATION_ZOOM_OFFSET = 5;
const APP_VERSION = "22.2";

window.__AMSTERDAM_LOCATIES_VERSION__ = APP_VERSION;

const statusText = document.querySelector("#statusText");
const locationList = document.querySelector("#locationList");
const searchInput = document.querySelector("#searchInput");
const modal = document.querySelector("#detailModal");
const modalImage = document.querySelector("#modalImage");
const modalCaption = document.querySelector("#modalCaption");
const modalTitle = document.querySelector("#modalTitle");
const modalDescription = document.querySelector("#modalDescription");
const modalCount = document.querySelector("#modalCount");
const prevImageButton = document.querySelector("#prevImage");
const nextImageButton = document.querySelector("#nextImage");
const locateButton = document.querySelector("#locateButton");

let locations = [];
let filteredLocations = [];
let markers = new Map();
let activeLocation = null;
let activeImageIndex = 0;
let latestBounds = null;
let hasCenteredOnUser = false;
let userLocationMarker = null;
let selectedLocationId = "";
const startMapZoom = 15;
const selectedMapZoom = 18;
const mapTransitionDuration = 0.8;
const dotTapRadius = 22;
const selectedDotVerticalOffsetRatio = 0.1;
let startMapCenter = L.latLng(AMSTERDAM_CENTER);
let suppressMapDeselectUntil = 0;
let lastPopupActivationAt = 0;
let suppressNextPopupCloseDeselect = false;

const map = L.map("map", {
  attributionControl: false,
  doubleClickZoom: false,
  zoomControl: false,
  scrollWheelZoom: true
}).setView(AMSTERDAM_CENTER, 12);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  subdomains: "abcd",
  maxZoom: 19
}).addTo(map);

window.addEventListener("resize", () => refreshMapLayout({ fitBounds: false, keepCurrentView: true }));

init();

async function init() {
  bindEvents();

  try {
    const rows = await loadSheetRows();
    locations = await normalizeRows(rows);
    filteredLocations = locations;
    renderLocations(filteredLocations);
    renderMarkers(filteredLocations);
    statusText.textContent = locations.length
      ? `${locations.length} locaties geladen.`
      : "Geen bruikbare locaties gevonden in de spreadsheet.";
    if (!isMobileViewport()) {
      centerMapOnUserLocation();
    }
  } catch (error) {
    console.error(error);
    statusText.textContent = "De spreadsheet kon niet worden geladen. Controleer of delen via link aan staat.";
    renderEmptyState("Geen data beschikbaar. Zet de Google Sheet op delen via link of publiceer hem voor web.");
  }
}

function bindEvents() {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    filteredLocations = locations.filter((location) => {
      const haystack = `${location.name} ${location.description} ${location.address}`.toLowerCase();
      return haystack.includes(query);
    });
    renderLocations(filteredLocations);
    renderMarkers(filteredLocations, { fitToBounds: !hasCenteredOnUser });
  });

  document.querySelectorAll("[data-close-modal]").forEach((element) => {
    element.addEventListener("click", closeModal);
  });

  prevImageButton.addEventListener("click", () => showImage(activeImageIndex - 1));
  nextImageButton.addEventListener("click", () => showImage(activeImageIndex + 1));
  locateButton.addEventListener("click", handleLocateButtonClick);
  document.addEventListener("pointerup", handlePopupCardActivation, true);
  document.addEventListener("click", handlePopupCardActivation, true);
  document.addEventListener("touchend", handlePopupCardActivation, true);
  map.getContainer().addEventListener("click", handleMapClick, true);
  document.addEventListener("click", handleDocumentMapClick, true);
  document.addEventListener("pointerup", handleDocumentMapClick, true);
  document.addEventListener("touchend", handleDocumentMapClick, true);

  document.addEventListener("keydown", (event) => {
    if (!modal.classList.contains("is-open")) return;
    if (event.key === "Escape") closeModal();
    if (event.key === "ArrowLeft") showImage(activeImageIndex - 1);
    if (event.key === "ArrowRight") showImage(activeImageIndex + 1);
  });
}

function handlePopupCardActivation(event) {
  const popupCard = event.target.closest(".popup-card[data-popup-location-id]");
  if (!popupCard) return;

  event.preventDefault();
  event.stopPropagation();

  const now = Date.now();
  if (now - lastPopupActivationAt < 450) return;
  lastPopupActivationAt = now;

  const location = locations.find((item) => item.id === popupCard.dataset.popupLocationId);
  if (location) {
    openModal(location);
  }
}

function handleMapClick(event) {
  if (shouldSuppressMapDeselect()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  const dot = event.target.closest("[data-dot-location-id], .map-dot-marker");
  if (dot) {
    const id = dot.dataset.dotLocationId;
    const marker = markers.get(id);

    if (marker) {
      event.preventDefault();
      event.stopPropagation();
      selectLocation(id);
      marker.openPopup();
    }

    return;
  }

  if (event.target.closest(".leaflet-popup")) return;

  map.closePopup();
  deselectLocation();
}

function handleDocumentMapClick(event) {
  if (event.target.closest(".leaflet-popup, .sidebar, .modal, .locate-button")) return;
  const pointEvent = event.changedTouches?.[0] || event;
  if (pointEvent.clientX === undefined || pointEvent.clientY === undefined) return;

  const mapRect = map.getContainer().getBoundingClientRect();
  const point = L.point(pointEvent.clientX - mapRect.left, pointEvent.clientY - mapRect.top);

  if (point.x < 0 || point.y < 0 || point.x > mapRect.width || point.y > mapRect.height) return;

  const nearest = getNearestMarker(point);
  if (nearest && nearest.distance <= dotTapRadius) {
    event.preventDefault();
    event.stopPropagation();
    suppressMapDeselectUntil = Date.now() + 650;
    selectLocation(nearest.id);
    nearest.marker.openPopup();
    return;
  }

  if (shouldSuppressMapDeselect()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  map.closePopup();
  deselectLocation();
}

function handleLocateButtonClick(event) {
  event.preventDefault();
  event.stopPropagation();
  centerMapOnUserLocation({ fromButton: true });
}

function shouldSuppressMapDeselect() {
  return selectedLocationId && Date.now() < suppressMapDeselectUntil;
}

function getNearestMarker(point) {
  let nearest = null;

  markers.forEach((marker, id) => {
    const markerPoint = map.latLngToContainerPoint(marker.getLatLng());
    const distance = point.distanceTo(markerPoint);

    if (!nearest || distance < nearest.distance) {
      nearest = { id, marker, distance };
    }
  });

  return nearest;
}

function loadSheetRows() {
  return new Promise((resolve, reject) => {
    const callbackName = `googleSheetCallback_${Date.now()}`;
    const script = document.createElement("script");
    const url = new URL(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`);

    url.searchParams.set("gid", SHEET_GID);
    url.searchParams.set("headers", "1");
    url.searchParams.set("cacheBust", `${Date.now()}`);
    url.searchParams.set("tqx", `out:json;responseHandler:${callbackName}`);

    window[callbackName] = (payload) => {
      cleanup();

      if (payload.status === "error") {
        reject(new Error(payload.errors?.[0]?.detailed_message || "Google Sheets error"));
        return;
      }

      resolve(parseGoogleTable(payload.table));
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Spreadsheet script kon niet worden geladen"));
    };

    function cleanup() {
      script.remove();
      delete window[callbackName];
    }

    script.src = url.toString();
    document.head.appendChild(script);
  });
}

function parseGoogleTable(table) {
  const headers = table.cols.map((column, index) => column.label || column.id || `Kolom ${index + 1}`);

  return table.rows.map((row) => {
    return headers.reduce((record, header, index) => {
      const cell = row.c[index];
      record[header] = cell?.f ?? cell?.v ?? "";
      return record;
    }, {});
  });
}

async function normalizeRows(rows) {
  const mapped = rows.map((row, index) => normalizeRow(row, index)).filter(Boolean);
  const missingCoordinates = mapped.filter((location) => !hasCoordinates(location) && location.address);

  for (const location of missingCoordinates) {
    const result = await geocodeAmsterdamAddress(location.address);
    if (result) {
      location.lat = result.lat;
      location.lng = result.lng;
    }
  }

  return mapped.filter(hasCoordinates);
}

function normalizeRow(row, index) {
  const fields = Object.entries(row).reduce((result, [key, value]) => {
    result[normalizeKey(key)] = typeof value === "string" ? value.trim() : value;
    return result;
  }, {});

  const images = collectImages(row);
  const name = pick(fields, ["naam", "name", "titel", "title", "locatie", "location"]) || `Locatie ${index + 1}`;
  const description = pick(fields, ["omschrijving", "beschrijving", "description", "tekst", "info", "toelichting"]) || "";
  const address = pick(fields, ["adres", "address", "straat", "plek"]) || "";
  const coordinates = normalizeCoordinates(
    parseCoordinate(pick(fields, ["lat", "latitude", "breedtegraad", "y"])),
    parseCoordinate(pick(fields, ["lng", "lon", "long", "longitude", "lengtegraad", "x"]))
  );

  if (!images.length && !name && !address) return null;

  return {
    id: `location-${index}`,
    name,
    description,
    address,
    lat: coordinates.lat,
    lng: coordinates.lng,
    thumbnail: images[0]?.url || "",
    images
  };
}

function collectImages(row) {
  const entries = Object.entries(row);
  const imageGroups = new Map();

  entries.forEach(([key, value]) => {
    const normalized = normalizeKey(key);
    const number = normalized.match(/\d+/)?.[0] || "1";
    const isImageColumn = /(afbeelding|image|foto|photo|cloudflare)/.test(normalized);
    const isCaptionColumn = /(onderschrift|bijschrift|caption)/.test(normalized);

    if (isImageColumn && !isCaptionColumn && value) {
      const group = imageGroups.get(number) || {};
      group.url = String(value).trim();
      imageGroups.set(number, group);
    }

    if (isCaptionColumn && value) {
      const group = imageGroups.get(number) || {};
      group.caption = String(value).trim();
      imageGroups.set(number, group);
    }
  });

  return [...imageGroups.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, image]) => image)
    .filter((image) => isLikelyImageUrl(image.url));
}

function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function pick(fields, keys) {
  for (const key of keys) {
    if (fields[key] !== undefined && fields[key] !== "") return fields[key];
  }
  return "";
}

function parseCoordinate(value) {
  if (value === undefined || value === "") return null;
  const cleaned = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCoordinates(lat, lng) {
  const looksLikeAmsterdamLat = (value) => value >= 50 && value <= 54;
  const looksLikeAmsterdamLng = (value) => value >= 3 && value <= 8;

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    if (looksLikeAmsterdamLng(lat) && looksLikeAmsterdamLat(lng)) {
      return { lat: lng, lng: lat };
    }
  }

  return { lat, lng };
}

function hasCoordinates(location) {
  return Number.isFinite(location.lat) && Number.isFinite(location.lng);
}

async function geocodeAmsterdamAddress(address) {
  const cacheKey = `geocode:${address}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", `${address}, Amsterdam, Nederland`);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    const [result] = await response.json();
    if (!result) return null;

    const coordinates = {
      lat: Number(result.lat),
      lng: Number(result.lon)
    };

    localStorage.setItem(cacheKey, JSON.stringify(coordinates));
    return coordinates;
  } catch {
    return null;
  }
}

function isLikelyImageUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function renderLocations(items) {
  if (!items.length) {
    renderEmptyState("Geen locaties gevonden.");
    return;
  }

  locationList.innerHTML = items.map((location) => `
    <li>
      <button class="location-card" type="button" data-location-id="${location.id}">
        ${thumbnailHtml(location)}
        <strong>${escapeHtml(location.name)}</strong>
      </button>
    </li>
  `).join("");

  locationList.querySelectorAll("[data-location-id]").forEach((button) => {
    button.addEventListener("click", () => focusLocation(button.dataset.locationId));
  });
}

function renderEmptyState(message) {
  locationList.innerHTML = `<li class="empty-state">${escapeHtml(message)}</li>`;
}

function renderMarkers(items, options = {}) {
  const { fitToBounds = true } = options;

  markers.forEach((marker) => marker.remove());
  markers = new Map();

  const bounds = [];

  items.forEach((location) => {
    const marker = L.marker([location.lat, location.lng], {
      icon: createDotIcon(location),
      title: location.name
    }).addTo(map);
    marker.locationId = location.id;
    const markerElement = marker.getElement();
    markerElement?.setAttribute("data-dot-location-id", location.id);
    markerElement?.addEventListener("pointerdown", (event) => activateMarker(event, location.id), true);
    markerElement?.addEventListener("click", (event) => activateMarker(event, location.id), true);
    markerElement?.addEventListener("pointerup", (event) => activateMarker(event, location.id), true);
    markerElement?.addEventListener("touchstart", (event) => activateMarker(event, location.id), true);
    markerElement?.addEventListener("touchend", (event) => activateMarker(event, location.id), true);
    marker.bindPopup(popupHtml(location), {
      autoPan: false,
      closeButton: false,
      closeOnClick: true
    });
    marker.on("click", () => selectLocation(location.id));
    marker.on("popupopen", () => {
      window.setTimeout(() => selectLocation(location.id), 0);
    });
    marker.on("popupclose", () => {
      window.setTimeout(() => {
        if (suppressNextPopupCloseDeselect) {
          suppressNextPopupCloseDeselect = false;
          return;
        }

        if (!document.querySelector(".popup-card[data-popup-location-id]")) {
          deselectLocation();
        }
      }, 0);
    });
    markers.set(location.id, marker);
    bounds.push([location.lat, location.lng]);
  });

  if (bounds.length) {
    latestBounds = L.latLngBounds(bounds);
    startMapCenter = getAllDotsCenter();
    if (fitToBounds) {
      resetToStartMap();
    }
  } else {
    latestBounds = null;
  }
}

function createDotIcon(location) {
  return L.divIcon({
    className: "map-dot-marker",
    html: `<span class="map-dot-button" data-dot-location-id="${escapeAttribute(location.id)}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -9]
  });
}

function activateMarker(event, id) {
  const marker = markers.get(id);
  if (!marker) return;

  event.preventDefault();
  event.stopPropagation();
  suppressMapDeselectUntil = Date.now() + 650;
  selectLocation(id);
  marker.openPopup();
}

function selectLocation(id) {
  const marker = markers.get(id);
  if (!marker) return;

  selectedLocationId = id;
  setSelectedDot(id);
  keepSelectedDotCentered(id);
}

function deselectLocation() {
  selectedLocationId = "";
  setSelectedDot("");
  resetToStartMap();
}

function setSelectedDot(id) {
  markers.forEach((marker, markerId) => {
    const element = marker.getElement();
    const isSelected = markerId === id;

    element?.classList.toggle("is-selected", isSelected);
    element?.querySelector(".map-dot-button")?.classList.toggle("is-selected", isSelected);
  });
}

function focusDotMarker(marker, options = {}) {
  const { animate = true } = options;
  selectedLocationId = marker.locationId || selectedLocationId;
  syncMapContainerSize();
  map.invalidateSize();
  moveMap(getSelectedDotMapCenter(marker.getLatLng()), selectedMapZoom, animate);
}

function keepSelectedDotCentered(id) {
  const marker = markers.get(id);
  if (!marker) return;

  focusDotMarker(marker, { animate: true });

  window.setTimeout(() => {
    if (selectedLocationId === id) {
      focusDotMarker(marker, { animate: false });
    }
  }, (mapTransitionDuration * 1000) + 180);
}

function resetToStartMap() {
  syncMapContainerSize();
  map.invalidateSize();
  startMapCenter = getAllDotsCenter();
  moveMap(startMapCenter, startMapZoom, true);
}

function moveMap(center, zoom, animate) {
  if (animate) {
    map.flyTo(center, zoom, {
      animate: true,
      duration: mapTransitionDuration,
      easeLinearity: 0.25,
      noMoveStart: true
    });
    return;
  }

  map.setView(center, zoom, { animate: false });
}

function getSelectedDotMapCenter(latLng) {
  const projectedPoint = map.project(latLng, selectedMapZoom);
  const yOffset = map.getSize().y * selectedDotVerticalOffsetRatio;

  return map.unproject(projectedPoint.add([0, yOffset]), selectedMapZoom);
}

function refreshMapLayout(options = {}) {
  const { fitBounds = true, keepCurrentView = false } = options;

  requestAnimationFrame(() => {
    syncMapContainerSize();
    map.invalidateSize();

    if (selectedLocationId) {
      const marker = markers.get(selectedLocationId);
      if (marker) {
        focusDotMarker(marker);
      }
      return;
    }

    if (fitBounds && latestBounds && !keepCurrentView) {
      resetToStartMap();
    }
  });
}

function syncMapContainerSize() {
  const mapElement = map.getContainer();
  const region = document.querySelector(".map-region");

  if (!isMobileViewport()) {
    mapElement.style.width = "";
    region.style.width = "";
    return;
  }

  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  mapElement.style.width = `${viewportWidth}px`;
  region.style.width = `${viewportWidth}px`;
}

function getAllDotsCenter() {
  return latestBounds ? latestBounds.getCenter() : L.latLng(AMSTERDAM_CENTER);
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function centerMapOnUserLocation(options = {}) {
  const { fromButton = false } = options;

  if (!("geolocation" in navigator)) {
    if (fromButton) {
      statusText.textContent = "Locatiebepaling wordt niet ondersteund door deze browser.";
    }
    return;
  }

  if (fromButton) {
    locateButton.disabled = true;
    locateButton.classList.add("is-loading");
    locateButton.setAttribute("aria-busy", "true");
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      hasCenteredOnUser = true;
      const userLatLng = [position.coords.latitude, position.coords.longitude];
      const zoom = fromButton
        ? Math.min(map.getMaxZoom(), selectedMapZoom)
        : Math.min(map.getMaxZoom(), 14 + USER_LOCATION_ZOOM_OFFSET);

      suppressNextPopupCloseDeselect = true;
      map.closePopup();
      selectedLocationId = "";
      setSelectedDot("");
      moveMap(userLatLng, zoom, true);
      renderUserLocationMarker(userLatLng);
      statusText.textContent = `${locations.length} locaties geladen. Kaart gecentreerd op je locatie.`;
      finishLocateButton();
    },
    () => {
      statusText.textContent = locations.length
        ? `${locations.length} locaties geladen.`
        : "Geen bruikbare locaties gevonden in de spreadsheet.";
      if (fromButton) {
        statusText.textContent = "Je actuele locatie kon niet worden bepaald.";
      }
      finishLocateButton();
    },
    {
      enableHighAccuracy: true,
      maximumAge: fromButton ? 0 : 60000,
      timeout: 10000
    }
  );
}

function finishLocateButton() {
  locateButton.disabled = false;
  locateButton.classList.remove("is-loading");
  locateButton.removeAttribute("aria-busy");
}

function renderUserLocationMarker(latLng) {
  if (userLocationMarker) {
    userLocationMarker.setLatLng(latLng);
    return;
  }

  userLocationMarker = L.circleMarker(latLng, {
    radius: 8,
    color: "#ffffff",
    weight: 3,
    fillColor: "#0d6b57",
    fillOpacity: 1
  }).addTo(map);
}

function focusLocation(id) {
  const location = locations.find((item) => item.id === id);
  const marker = markers.get(id);
  if (!location || !marker) return;

  map.setView([location.lat, location.lng], Math.max(map.getZoom(), 15), { animate: true });
  marker.openPopup();
}

function popupHtml(location) {
  return `
    <button class="popup-card" type="button" data-popup-location-id="${location.id}">
      ${thumbnailHtml(location)}
      <strong>${escapeHtml(location.name)}</strong>
    </button>
  `;
}

function thumbnailHtml(location) {
  if (!location.thumbnail) {
    return `<img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='136' height='116' viewBox='0 0 136 116'%3E%3Crect width='136' height='116' fill='%23d8edf2'/%3E%3Cpath d='M28 81 54 53l18 18 10-12 26 22H28Z' fill='%230d6b57' opacity='.75'/%3E%3Ccircle cx='91' cy='39' r='10' fill='%23ffffff' opacity='.9'/%3E%3C/svg%3E">`;
  }

  return `<img alt="" src="${escapeAttribute(location.thumbnail)}" loading="lazy">`;
}

function openModal(location) {
  activeLocation = location;
  activeImageIndex = 0;
  modalTitle.textContent = location.name;
  modalDescription.textContent = location.description || location.address || "";
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  showImage(0);
}

function closeModal() {
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  activeLocation = null;
}

function showImage(index) {
  if (!activeLocation) return;

  const images = activeLocation.images.length
    ? activeLocation.images
    : [{ url: activeLocation.thumbnail, caption: "" }].filter((image) => image.url);

  if (!images.length) return;

  activeImageIndex = (index + images.length) % images.length;
  const image = images[activeImageIndex];

  modalImage.src = image.url;
  modalImage.alt = image.caption || activeLocation.name;
  modalCaption.textContent = image.caption || "";
  modalCount.textContent = `${activeImageIndex + 1} van ${images.length}`;
  prevImageButton.disabled = images.length < 2;
  nextImageButton.disabled = images.length < 2;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
