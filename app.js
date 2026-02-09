// --- Configuration ---------------------------------------------------------
// Replace this with your real Google Maps API key, or
// keep it here and configure the script tag in index.html instead.
const GOOGLE_MAPS_API_KEY = "YOUR_API_KEY_HERE";

// --- Global map state ------------------------------------------------------
let map;
let directionsService;
let directionsRenderer;
let placesService;
let restaurantMarkers = [];

// Called by Maps JS API when it loads (see script tag in index.html)
function initMap() {
  const defaultCenter = { lat: 12.9716, lng: 77.5946 }; // Bengaluru

  map = new google.maps.Map(document.getElementById("map"), {
    center: defaultCenter,
    zoom: 11,
    disableDefaultUI: false,
    mapId: "DEMO_RESTO_DISCOVERY",
  });

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    map,
    suppressMarkers: false,
  });

  placesService = new google.maps.places.PlacesService(map);

  attachFormHandler();
}

// --- UI helpers ------------------------------------------------------------
function setError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.hidden = !message;
}

function setResultCount(text, isActive) {
  const el = document.getElementById("result-count");
  el.textContent = text;
  el.classList.toggle("pill-muted", !isActive);
}

function clearRestaurantMarkers() {
  restaurantMarkers.forEach((m) => m.setMap(null));
  restaurantMarkers = [];
}

// --- Route + restaurant logic ----------------------------------------------

function attachFormHandler() {
  const form = document.getElementById("route-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    setResultCount("Searching…", true);

    const start = document.getElementById("start").value.trim();
    const end = document.getElementById("end").value.trim();
    const journeyTime = document.getElementById("journeyTime").value;
    const mealTime = document.getElementById("mealTime").value;
    const cuisine = document.getElementById("cuisine").value.trim();
    const openNow = document.getElementById("openNow").checked;

    if (!start || !end || !journeyTime || !mealTime) {
      setError("Please fill in starting point, destination and both times.");
      setResultCount("Missing info", false);
      return;
    }

    try {
      const route = await calculateRoute(start, end);
      directionsRenderer.setDirections(route);

      const leg = route.routes[0].legs[0];
      const mealTargetMinutes = computeMealOffsetMinutes(
        journeyTime,
        mealTime
      );

      const pointForMeal = findRoutePointForMinuteOffset(
        leg,
        mealTargetMinutes
      );

      await searchRestaurantsNearPoint(pointForMeal, {
        cuisine,
        openNow,
        leg,
      });
    } catch (err) {
      console.error(err);
      setError(
        "We couldn't compute the route or places. Please check your API key, locations and internet connection."
      );
      setResultCount("Error", false);
    }
  });
}

function calculateRoute(origin, destination) {
  return new Promise((resolve, reject) => {
    directionsService.route(
      {
        origin,
        destination,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        if (status === google.maps.DirectionsStatus.OK) {
          resolve(result);
        } else {
          reject(new Error("Directions request failed: " + status));
        }
      }
    );
  });
}

// Compute the number of minutes from journey start until the desired meal time.
// Handles overnight trips (e.g. start 23:00, meal 01:00).
function computeMealOffsetMinutes(journeyTime, mealTime) {
  const [jHour, jMin] = journeyTime.split(":").map(Number);
  const [mHour, mMin] = mealTime.split(":").map(Number);

  const journeyMinutes = jHour * 60 + jMin;
  let mealMinutes = mHour * 60 + mMin;

  if (mealMinutes < journeyMinutes) {
    mealMinutes += 24 * 60; // next day
  }

  return mealMinutes - journeyMinutes;
}

// Given a route leg and a target offset in minutes from departure, find
// an approximate LatLng along the leg where the user will be at that time.
function findRoutePointForMinuteOffset(leg, targetMinutes) {
  const totalSeconds = leg.duration.value;
  const totalMinutes = totalSeconds / 60;

  // Clamp to range [0, total]
  const clampedMinutes = Math.max(0, Math.min(targetMinutes, totalMinutes));
  const fraction = clampedMinutes / totalMinutes || 0;

  const path = [];
  leg.steps.forEach((step) => {
    const stepPath = google.maps.geometry?.encoding
      ? google.maps.geometry.encoding.decodePath(step.polyline.points)
      : [step.start_location, step.end_location];
    path.push(...stepPath);
  });

  if (path.length === 0) {
    return leg.end_location;
  }

  const index = Math.floor(fraction * (path.length - 1));
  return path[index];
}

function searchRestaurantsNearPoint(latLng, options) {
  const { cuisine, openNow, leg } = options;

  clearRestaurantMarkers();
  const listEl = document.getElementById("restaurant-list");
  listEl.innerHTML = "";

  return new Promise((resolve, reject) => {
    const request = {
      location: latLng,
      radius: 8000, // 8km around the meal point
      type: "restaurant",
      keyword: cuisine || undefined,
      openNow: openNow || undefined,
    };

    placesService.nearbySearch(request, (results, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !results) {
        setError("No restaurants found near that part of the route.");
        setResultCount("0 matches", false);
        return reject(new Error("Places search failed: " + status));
      }

      const top = results.slice(0, 5);
      if (!top.length) {
        setError("No restaurants matched your filters near the meal time.");
        setResultCount("0 matches", false);
        return resolve();
      }

      setError("");
      setResultCount(`${top.length} suggestion(s)`, true);

      top.forEach((place, index) => {
        addRestaurantResult(place, index, latLng, leg);
      });

      resolve();
    });
  });
}

// Add restaurant to list + map marker
function addRestaurantResult(place, index, centerLatLng, leg) {
  const listEl = document.getElementById("restaurant-list");

  const li = document.createElement("li");
  const card = document.createElement("div");
  card.className = "restaurant-card";

  const nameEl = document.createElement("div");
  nameEl.className = "restaurant-name";
  nameEl.textContent = place.name;

  const metaEl = document.createElement("div");
  metaEl.className = "restaurant-meta";

  if (place.rating) {
    const ratingSpan = document.createElement("span");
    ratingSpan.textContent = `★ ${place.rating.toFixed(1)}`;
    metaEl.appendChild(ratingSpan);
  }

  if (place.user_ratings_total) {
    const countSpan = document.createElement("span");
    countSpan.className = "meta-dot";
    countSpan.textContent = `${place.user_ratings_total} reviews`;
    metaEl.appendChild(countSpan);
  }

  if (place.vicinity) {
    const vicinitySpan = document.createElement("span");
    vicinitySpan.className = "meta-dot";
    vicinitySpan.textContent = place.vicinity;
    metaEl.appendChild(vicinitySpan);
  }

  const tagSpan = document.createElement("span");
  tagSpan.className = "meta-tag";
  tagSpan.textContent = "Along your route";
  metaEl.appendChild(tagSpan);

  const etaBadge = document.createElement("span");
  etaBadge.className = "eta-badge";
  etaBadge.textContent = "Tap to view";

  card.appendChild(nameEl);
  card.appendChild(metaEl);
  card.appendChild(etaBadge);
  li.appendChild(card);
  listEl.appendChild(li);

  const marker = new google.maps.Marker({
    map,
    position: place.geometry.location,
    title: place.name,
    label: String(index + 1),
  });
  restaurantMarkers.push(marker);

  const info = new google.maps.InfoWindow({
    content: `<strong>${place.name}</strong><br/>${place.vicinity || ""}`,
  });

  marker.addListener("click", () => {
    info.open(map, marker);
  });

  card.addEventListener("click", () => {
    map.panTo(place.geometry.location);
    map.setZoom(15);
    info.open(map, marker);
  });
}

// Expose initMap globally so the Google script callback can find it
window.initMap = initMap;

