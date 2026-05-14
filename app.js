const SHEET_ID = "1rcKb4GvBBX9XjfYLc-yU3zlcEzZ1fXhC7GWl6-WC-Ro";
const SHEET_GID = "0";
const AMSTERDAM_CENTER = [52.3676, 4.9041];
const USER_LOCATION_ZOOM_OFFSET = 5;
const APP_VERSION = "6";

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

let locations = [];
let filteredLocations = [];
let markers = new Map();
let activeLocation = null;
let activeImageIndex = 0;
let latestBounds = null;
let hasCenteredOnUser = false;
let userLocationMarker = null;
let dotClickTimer = null;
let lastDotClick = { id: "", time: 0 };

const map = L.map("map", {
  doubleClickZoom: false,
  zoomControl: false,
  scrollWheelZoom: true
}).setView(AMSTERDAM_CENTER, 12);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  subdomains: "abcd",
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
}).addTo(map);

window.addEventListener("resize", () => refreshMapLayout({ fitBounds: false }));

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
  map.getContainer().addEventListener("click", handleDotClick, true);
  map.getContainer().addEventListener("dblclick", handleDotDoubleClick, true);

  document.addEventListener("keydown", (event) => {
    if (!modal.classList.contains("is-open")) return;
    if (event.key === "Escape") closeModal();
    if (event.key === "ArrowLeft") showImage(activeImageIndex - 1);
    if (event.key === "ArrowRight") showImage(activeImageIndex + 1);
  });
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
    marker.bindPopup(popupHtml(location));
    marker.on("popupopen", () => {
      const button = document.querySelector(`[data-popup-location-id="${location.id}"]`);
      button?.addEventListener("click", () => openModal(location));
    });
    markers.set(location.id, marker);
    bounds.push([location.lat, location.lng]);
  });

  if (bounds.length) {
    latestBounds = L.latLngBounds(bounds);
    refreshMapLayout({ fitBounds: fitToBounds });
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

function handleDotClick(event) {
  const button = event.target.closest("[data-dot-location-id]");
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();

  const id = button.dataset.dotLocationId;
  const marker = markers.get(id);
  const location = locations.find((item) => item.id === id);
  if (!marker || !location) return;

  const now = Date.now();
  if (event.detail >= 2 || (lastDotClick.id === id && now - lastDotClick.time < 700)) {
    cancelDotClickTimer();
    marker.closePopup();
    openModal(location);
  } else {
    cancelDotClickTimer();
    dotClickTimer = window.setTimeout(() => marker.openPopup(), 520);
  }

  lastDotClick = { id, time: now };
}

function handleDotDoubleClick(event) {
  const button = event.target.closest("[data-dot-location-id]");
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();

  const id = button.dataset.dotLocationId;
  const marker = markers.get(id);
  const location = locations.find((item) => item.id === id);
  if (!marker || !location) return;

  cancelDotClickTimer();
  marker.closePopup();
  openModal(location);
}

function cancelDotClickTimer() {
  if (dotClickTimer) {
    window.clearTimeout(dotClickTimer);
    dotClickTimer = null;
  }
}

function refreshMapLayout(options = {}) {
  const { fitBounds = true } = options;

  requestAnimationFrame(() => {
    map.invalidateSize();

    if (fitBounds && latestBounds) {
      map.fitBounds(latestBounds, getBoundsOptions());
    }
  });
}

function getBoundsOptions() {
  return isMobileViewport()
    ? { paddingTopLeft: [22, 22], paddingBottomRight: [54, 76], maxZoom: 16 }
    : { padding: [60, 60], maxZoom: 14 };
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function centerMapOnUserLocation() {
  if (!("geolocation" in navigator)) return;

  navigator.geolocation.getCurrentPosition(
    (position) => {
      hasCenteredOnUser = true;
      const userLatLng = [position.coords.latitude, position.coords.longitude];
      const zoom = Math.min(map.getMaxZoom(), 14 + USER_LOCATION_ZOOM_OFFSET);

      map.setView(userLatLng, zoom, { animate: true });
      renderUserLocationMarker(userLatLng);
      statusText.textContent = `${locations.length} locaties geladen. Kaart gecentreerd op je locatie.`;
    },
    () => {
      statusText.textContent = locations.length
        ? `${locations.length} locaties geladen.`
        : "Geen bruikbare locaties gevonden in de spreadsheet.";
    },
    {
      enableHighAccuracy: true,
      maximumAge: 60000,
      timeout: 10000
    }
  );
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
