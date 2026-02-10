// --- Configuration ---------------------------------------------------------
// Replace this with your real Google Maps API key, or
// keep it here and configure the script tag in index.html instead.
const GOOGLE_MAPS_API_KEY = "AIzaSyDqKeq3a0O__Mm7EQLy0zrHYuJUq8Ly1Ps";

// --- Global map state ------------------------------------------------------
let map;
let directionsService;
let directionsRenderer;
let placesService;
let restaurantMarkers = [];
let currentPlaces = [];
let currentCuisineFilters = [];
let activeCuisineFilter = "all";

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

  // Attach Google Places Autocomplete to start & destination inputs
  const startInput = document.getElementById("start");
  const endInput = document.getElementById("end");

  if (startInput && endInput && google.maps.places?.Autocomplete) {
    const autocompleteOptions = {
      fields: ["formatted_address", "geometry", "name"],
    };

    const startAutocomplete = new google.maps.places.Autocomplete(
      startInput,
      autocompleteOptions
    );
    const endAutocomplete = new google.maps.places.Autocomplete(
      endInput,
      autocompleteOptions
    );

    startAutocomplete.bindTo("bounds", map);
    endAutocomplete.bindTo("bounds", map);
  }

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

// Derive human-readable cuisine tags from Google Places types
function deriveCuisineTags(place) {
  const tags = new Set();

  if (Array.isArray(place.types)) {
    place.types.forEach((type) => {
      if (type.endsWith("_restaurant") && type !== "restaurant") {
        const base = type.replace("_restaurant", "");
        const pretty =
          base.charAt(0).toUpperCase() + base.slice(1).replace(/_/g, " ");
        tags.add(pretty);
      }
    });
  }

  return Array.from(tags);
}

function renderCuisineFilter() {
  const container = document.getElementById("cuisine-filter");
  if (!container) return;

  container.innerHTML = "";

  if (!currentCuisineFilters.length) {
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";

  const makeChip = (label, value) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className =
      "cuisine-chip" +
      (activeCuisineFilter === value ? " cuisine-chip--active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      activeCuisineFilter = value;
      renderCuisineFilter();
      renderRestaurants();
    });
    return chip;
  };

  container.appendChild(makeChip("All cuisines", "all"));

  currentCuisineFilters.forEach((cuisine) => {
    container.appendChild(makeChip(cuisine, cuisine));
  });
}

function renderRestaurants() {
  const listEl = document.getElementById("restaurant-list");
  if (!listEl) return;

  listEl.innerHTML = "";
  clearRestaurantMarkers();

  if (!currentPlaces.length) {
    setResultCount("0 matches", false);
    return;
  }

  const filtered = currentPlaces.filter((place) => {
    if (activeCuisineFilter === "all") return true;
    const cuisines = place._cuisines || [];
    return cuisines.includes(activeCuisineFilter);
  });

  if (!filtered.length) {
    setResultCount("0 matches", false);
    return;
  }

  setError("");
  setResultCount(`${filtered.length} suggestion(s)`, true);

  filtered.forEach((place, index) => {
    addRestaurantResult(place, index);
  });
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
  const { cuisine, openNow } = options;

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

      const top = results.slice(0, 10);
      if (!top.length) {
        setError("No restaurants matched your filters near the meal time.");
        setResultCount("0 matches", false);
        return resolve();
      }

      // Attach derived cuisines to each place and build cuisine filters
      currentPlaces = top.map((place) => {
        place._cuisines = deriveCuisineTags(place);
        return place;
      });

      const cuisineSet = new Set();
      currentPlaces.forEach((place) => {
        (place._cuisines || []).forEach((c) => cuisineSet.add(c));
      });

      currentCuisineFilters = Array.from(cuisineSet).sort();
      activeCuisineFilter = "all";

      renderCuisineFilter();
      renderRestaurants();

      resolve();
    });
  });
}

// Add restaurant to list + map marker
function addRestaurantResult(place, index) {
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

  const cuisines = place._cuisines || [];
  cuisines.forEach((cuisineLabel) => {
    const cuisineSpan = document.createElement("span");
    cuisineSpan.className = "meta-tag";
    cuisineSpan.textContent = cuisineLabel;
    metaEl.appendChild(cuisineSpan);
  });

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

