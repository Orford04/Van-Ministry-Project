// config.js should be loaded before this file
async function initializeGoogleMaps() {
    try {
        await loadScript(`https://maps.googleapis.com/maps/api/js?key=${APP_CONFIG.GOOGLE_MAPS_API_KEY}&libraries=geometry&loading=async`);
        if (typeof google === 'undefined' || typeof google.maps === 'undefined') {
            throw new Error('Google Maps failed to load properly');
        }
        return true;
    } catch (error) {
        displayError('Failed to load Google Maps. Please check your internet connection and API key.');
        return false;
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.defer = true;
        script.onload = () => setTimeout(resolve, 100);
        script.onerror = () => reject(new Error('Failed to load Google Maps script'));
        document.head.appendChild(script);
    });
}

function showLoading() {
    document.getElementById('loading').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
}

function displayError(message) {
    console.error(message);
    const errorDiv = document.getElementById('error-messages');
    errorDiv.innerHTML += `<p class="text-red-500">${message}</p>`;
}

function clearErrors() {
    document.getElementById('error-messages').innerHTML = '';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getDirectionsWithRetry(directionsService, request, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await new Promise((resolve, reject) => {
                directionsService.route(request, (response, status) => {
                    if (status === 'OK') {
                        resolve(response);
                    } else {
                        reject(new Error(`Directions request failed: ${status}`));
                    }
                });
            });
            return result;
        } catch (error) {
            console.log(`Attempt ${i + 1} failed: ${error.message}`);
            if (i === maxRetries - 1) throw error;
            // Exponential backoff
            await sleep(1000 * Math.pow(2, i));
        }
    }
}

function resetUI() {
    document.getElementById('summary').classList.add('hidden');
    document.getElementById('result').classList.add('hidden');
    document.getElementById('map').classList.add('hidden');
    document.getElementById('resetButton').classList.add('hidden');
    clearErrors();
}

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

async function getDistanceMatrixWithRetry(service, addresses, maxRetries = 3) {
    const CHUNK_SIZE = 10;
    const addressChunks = chunkArray(addresses, CHUNK_SIZE);
    const matrix = Array(addresses.length).fill().map(() => Array(addresses.length).fill(0));
    
    for (let i = 0; i < addressChunks.length; i++) {
        for (let j = 0; j < addressChunks.length; j++) {
            let retries = 0;
            while (retries < maxRetries) {
                try {
                    const response = await new Promise((resolve, reject) => {
                        service.getDistanceMatrix({
                            origins: addressChunks[i],
                            destinations: addressChunks[j],
                            travelMode: google.maps.TravelMode.DRIVING,
                        }, (result, status) => {
                            if (status === google.maps.DistanceMatrixStatus.OK) {
                                resolve(result);
                            } else {
                                reject(new Error(`Distance Matrix failed: ${status}`));
                            }
                        });
                    });
                    
                    for (let k = 0; k < addressChunks[i].length; k++) {
                        for (let l = 0; l < addressChunks[j].length; l++) {
                            const originalRow = i * CHUNK_SIZE + k;
                            const originalCol = j * CHUNK_SIZE + l;
                            if (originalRow < addresses.length && originalCol < addresses.length) {
                                matrix[originalRow][originalCol] = 
                                    response.rows[k].elements[l].distance.value;
                            }
                        }
                    }
                    break;
                } catch (error) {
                    retries++;
                    if (retries === maxRetries) {
                        throw error;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000 * retries));
                }
            }
        }
    }
    return matrix;
}

function parseCSV(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const csv = event.target.result;
            const lines = csv.split('\n');
            const headers = lines[0].split(',');
            
            const streetIndex = headers.indexOf('Home Address Street');
            const cityIndex = headers.indexOf('Home Address City');
            const stateIndex = headers.indexOf('Home Address State');
            const zipIndex = headers.indexOf('Home Address Zip');
            const serviceIndex = headers.indexOf('Which service do you need a ride to?');
            const nameIndex = headers.indexOf('First Name');
            const lastNameIndex = headers.indexOf('Last Name');
            const phoneIndex = headers.indexOf('Mobile Phone Number');
            const notesIndex = headers.indexOf('Please list any physical needs that would affect transportation. If you don\'t have any, type NONE.');
            const riderCountIndex = headers.indexOf('How many people need a ride from your home?');

            if (streetIndex === -1 || cityIndex === -1 || stateIndex === -1 || zipIndex === -1) {
                throw new Error('Required address columns not found in CSV');
            }

            const records = lines.slice(1)
                .map(line => {
                    if (!line.trim()) return null;
                    const values = line.split(',');
                    return {
                        name: `${values[nameIndex]} ${values[lastNameIndex]}`.trim(),
                        street: values[streetIndex],
                        city: values[cityIndex],
                        state: values[stateIndex],
                        zip: values[zipIndex],
                        service: values[serviceIndex],
                        phone: values[phoneIndex],
                        notes: values[notesIndex] || 'None',
                        riderCount: values[riderCountIndex] ? parseInt(values[riderCountIndex]) : 1,
                        fullAddress: `${values[streetIndex]}, ${values[cityIndex]}, ${values[stateIndex]} ${values[zipIndex]}`
                    };
                })
                .filter(record => record && record.street && record.city && record.state);

            resolve(records);
        };
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function nearestNeighbor(matrix, records) {
    const n = records.length;
    const visited = new Array(n).fill(false);
    const route = [0];
    visited[0] = true;

    while (route.length < n) {
        const current = route[route.length - 1];
        let nearest = -1;
        let minDistance = Infinity;

        for (let i = 0; i < n; i++) {
            if (!visited[i] && matrix[current][i] < minDistance) {
                nearest = i;
                minDistance = matrix[current][i];
            }
        }

        route.push(nearest);
        visited[nearest] = true;
    }

    route.push(0);
    return route.map(index => records[index]);
}

function displaySummary(records) {
    const summary = document.getElementById('summary');
    const content = document.getElementById('summaryContent');
    
    const totalRiders = records.length;
    const serviceTypes = [...new Set(records.map(r => r.service))];
    
    content.innerHTML = `
        <p class="mb-2"><strong>Total Riders:</strong> ${totalRiders}</p>
        <p class="mb-2"><strong>Services:</strong> ${serviceTypes.join(', ')}</p>
    `;
    
    summary.classList.remove('hidden');
}

async function displayMapRoute(directionsService, directionsRenderer, addresses) {
    return new Promise((resolve, reject) => {
        const waypoints = addresses.slice(1, -1).map(address => ({
            location: address,
            stopover: true
        }));

        const request = {
            origin: addresses[0],
            destination: addresses[0],
            waypoints: waypoints,
            optimizeWaypoints: false,
            travelMode: google.maps.TravelMode.DRIVING,
        };

        directionsService.route(request, function(result, status) {
            if (status === 'OK') {
                document.getElementById('map').classList.remove('hidden');
                directionsRenderer.setDirections(result);
                resolve();
            } else {
                const error = new Error('Directions request failed: ' + status);
                displayError(error.message);
                reject(error);
            }
        });
    });
}

// Add this function to create the directions URL
function createGoogleMapsDirectionsUrl(route) {
    // Google Maps has a limit on the number of waypoints in the URL
    // We'll include all stops but be aware of potential limitations
    const origin = encodeURIComponent(route[0].fullAddress);
    const destination = encodeURIComponent(route[0].fullAddress); // Return to start
    
    // Convert intermediate stops to waypoints
    const waypoints = route.slice(1, -1)
        .map(stop => encodeURIComponent(stop.fullAddress))
        .join('|');
    
    return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&waypoints=${waypoints}&travelmode=driving`;
}

function enableDragAndDrop(routeList) {
    const sortable = new Sortable(routeList, {
        animation: 150,
        handle: '.route-item',
        filter: '.filtered', // Prevents dragging first/last items
        onStart: function(evt) {
            const index = evt.oldIndex;
            if (index === 0 || index === currentRecords.length - 1) {
                evt.preventDefault();
                return false;
            }
        },
        onEnd: async function(evt) {
            const { oldIndex, newIndex } = evt;
            
            // Prevent moving to start/end positions
            if (newIndex === 0 || newIndex === currentRecords.length - 1) {
                displayError("Cannot reorder the start or end points");
                updateRouteDisplay(currentRecords); // Reset display
                return;
            }

            // Update records array
            const newRecords = [...currentRecords];
            const [movedRecord] = newRecords.splice(oldIndex, 1);
            newRecords.splice(newIndex, 0, movedRecord);
            currentRecords = newRecords;
            
            await updateRouteDisplay(currentRecords);
        }
    });
}

// New function to update the display without reoptimizing
async function updateRouteDisplay(route) {
    try {
        showLoading();
        clearErrors();
        
        const map = new google.maps.Map(document.getElementById("map"), {
            zoom: 12,
            center: { lat: 38.8817, lng: -94.8191 },
        });

        const directionsService = new google.maps.DirectionsService();
        const directionsRenderer = new google.maps.DirectionsRenderer({
            map: map,
            suppressMarkers: false,
            draggable: false
        });

        // Get addresses in the current order
        const addresses = route.map(r => r.fullAddress);
        
        // Create the directions request
        const request = {
            origin: addresses[0],
            destination: addresses[0], // Return to start
            waypoints: addresses.slice(1, -1).map(address => ({
                location: address,
                stopover: true
            })),
            optimizeWaypoints: false,
            travelMode: google.maps.TravelMode.DRIVING,
        };

        // Use the retry mechanism for the directions request
        const result = await getDirectionsWithRetry(directionsService, request);
        
        document.getElementById('map').classList.remove('hidden');
        directionsRenderer.setDirections(result);
        
        displaySummary(route);
        displayRouteList(route);
    } catch (error) {
        displayError(`Route update failed: ${error.message}`);
        console.error(error);
    } finally {
        hideLoading();
    }
}

function displayRouteList(route) {
    const resultDiv = document.getElementById('result');
    const routeList = document.getElementById('routeList');
    
    resultDiv.classList.remove('hidden');
    resultDiv.className = 'mt-6 bg-white p-6 rounded-lg shadow';
    
    const existingButton = document.getElementById('directionsButtonContainer');
    if (existingButton) {
        existingButton.remove();
    }
    
    const directionsButton = document.createElement('div');
    directionsButton.id = 'directionsButtonContainer';
    directionsButton.className = 'mb-4 flex justify-end';
    directionsButton.innerHTML = `
        <button id="getDirections" class="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors duration-200 flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2.5 10a7.5 7.5 0 1 1 15 0 7.5 7.5 0 0 1-15 0z" clip-rule="evenodd"/>
                <path fill-rule="evenodd" d="M10 2.5a.5.5 0 0 1 .5.5v3.5a.5.5 0 0 1-1 0V3a.5.5 0 0 1 .5-.5z" clip-rule="evenodd"/>
                <path fill-rule="evenodd" d="M9.5 10a.5.5 0 0 1 .5-.5h3.5a.5.5 0 0 1 0 1H10a.5.5 0 0 1-.5-.5z" clip-rule="evenodd"/>
            </svg>
            Get Directions in Google Maps
        </button>
    `;
    
    resultDiv.insertBefore(directionsButton, routeList);
    routeList.innerHTML = '';
    currentRecords = route;
   
    route.forEach((record, index) => {
        const li = document.createElement('li');
        const isStartPoint = index === 0;
        const isEndPoint = index === route.length - 1;
        
        li.className = `route-item mb-4 p-4 rounded-lg shadow-sm relative border ${
            isStartPoint ? 'bg-green-50 border-green-200 filtered' : 
            isEndPoint ? 'bg-red-50 border-red-200 filtered' : 
            'bg-gray-50 border-gray-200'
        }`;
        
        li.draggable = !isStartPoint && !isEndPoint;
        
        const dragHandle = (!isStartPoint && !isEndPoint) ? `
            <div class="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
                ⋮⋮
            </div>
        ` : '';

        const pointLabel = isStartPoint ? '(Start Point)' : 
                         isEndPoint ? '(End Point)' : '';
                         
        const riderCount = record.riderCount || 1; // Fallback to 1 if not specified
        const riderText = riderCount === 1 ? 'rider' : 'riders';

        li.innerHTML = `
            ${dragHandle}
            <div class="font-semibold text-gray-800 ml-6">
                ${record.name} 
                <span class="text-sm font-normal text-gray-600">- ${riderCount} ${riderText} ${pointLabel}</span>
            </div>
            <div class="text-gray-700 mt-1 ml-6">${record.fullAddress}</div>
            <div class="text-sm text-gray-600 mt-1 ml-6">Phone: ${record.phone}</div>
            <div class="text-sm text-gray-600 mt-1 ml-6">Notes: ${record.notes}</div>
            ${(!isStartPoint && !isEndPoint) ? `
                <button class="delete-stop absolute top-3 right-3 px-3 py-1.5 bg-red-500 text-white rounded-md hover:bg-red-600 text-sm transition-colors duration-200" 
                        data-index="${index}">
                    Delete
                </button>
            ` : ''}
        `;
        routeList.appendChild(li);
    });

    enableDragAndDrop(routeList);

    document.getElementById('getDirections').addEventListener('click', () => {
        const directionsUrl = createGoogleMapsDirectionsUrl(currentRecords);
        window.open(directionsUrl, '_blank');
    });
}

// Also update the summary display to maintain consistent styling
function displaySummary(records) {
    const summary = document.getElementById('summary');
    const content = document.getElementById('summaryContent');
    
    summary.classList.remove('hidden');
    // Add white background and proper styling to the summary section
    summary.className = 'mt-6 bg-white p-6 rounded-lg shadow';
    
    const totalRiders = records.length;
    const serviceTypes = [...new Set(records.map(r => r.service))];
    
    content.innerHTML = `
        <div class="bg-gray-50 p-4 rounded-lg border border-gray-200">
            <p class="mb-2 text-gray-800"><strong>Total Riders:</strong> ${totalRiders}</p>
            <p class="text-gray-800"><strong>Services:</strong> ${serviceTypes.join(', ')}</p>
        </div>
    `;
}

async function handleFileSelect(event) {
    resetUI();
    showLoading();
    
    const file = document.getElementById('csvFile').files[0];
    const serviceFilter = document.getElementById('serviceFilter').value;
    
    if (!file) {
        hideLoading();
        return;
    }

    try {
        const records = await parseCSV(file);
        const filteredRecords = serviceFilter === 'all' 
            ? records 
            : records.filter(record => record.service.includes(serviceFilter));

        if (filteredRecords.length < 2) {
            throw new Error('Not enough addresses to optimize route');
        }

        currentRecords = filteredRecords; // Store the records globally

        const map = new google.maps.Map(document.getElementById("map"), {
            zoom: 12,
            center: { lat: 38.8817, lng: -94.8191 },
        });

        const directionsService = new google.maps.DirectionsService();
        const directionsRenderer = new google.maps.DirectionsRenderer();
        directionsRenderer.setMap(map);

        const addresses = filteredRecords.map(record => record.fullAddress);
        const service = new google.maps.DistanceMatrixService();
        
        const matrix = await getDistanceMatrixWithRetry(service, addresses);
        const route = nearestNeighbor(matrix, filteredRecords);
        
        displaySummary(filteredRecords);
        await displayMapRoute(directionsService, directionsRenderer, route.map(r => r.fullAddress));
        displayRouteList(route);
        
        document.getElementById('resetButton').classList.remove('hidden');
        
    } catch (error) {
        displayError(`Processing Error: ${error.message}`);
    } finally {
        hideLoading();
    }
}

let currentRecords = []; // Store the current records globally

function addNewStop() {
    const name = document.getElementById('newName').value.trim();
    const phone = document.getElementById('newPhone').value.trim();
    const street = document.getElementById('newStreet').value.trim();
    const city = document.getElementById('newCity').value.trim();
    const state = document.getElementById('newState').value.trim();
    const zip = document.getElementById('newZip').value.trim();
    const notes = document.getElementById('newNotes').value.trim();
    
    if (!name || !street || !city || !state || !zip) {
        displayError('Name, street address, city, state, and zip code are required');
        return;
    }

    const fullAddress = `${street}, ${city}, ${state} ${zip}`;
    
    const newStop = {
        name: name,
        fullAddress: fullAddress,
        street: street,
        city: city,
        state: state,
        zip: zip,
        phone: phone,
        notes: notes || 'None',
        riderCount: 1, // Default to 1 rider
        service: document.getElementById('serviceFilter').value
    };

    currentRecords.push(newStop);
    reoptimizeRoute();
    
    // Clear input fields
    document.getElementById('newName').value = '';
    document.getElementById('newPhone').value = '';
    document.getElementById('newStreet').value = '';
    document.getElementById('newCity').value = '';
    document.getElementById('newState').value = '';
    document.getElementById('newZip').value = '';
    document.getElementById('newNotes').value = '';
}

async function reoptimizeRoute(useNearestNeighbor = true) {
    if (!currentRecords || currentRecords.length < 2) {
        displayError('Need at least 2 stops for route optimization');
        return;
    }

    showLoading();
    clearErrors();
    
    try {
        if (useNearestNeighbor) {
            const addresses = currentRecords.map(record => record.fullAddress);
            const service = new google.maps.DistanceMatrixService();
            const matrix = await getDistanceMatrixWithRetry(service, addresses);
            const route = nearestNeighbor(matrix, currentRecords);
            currentRecords = route; // Update currentRecords with the optimized route
        }
        
        await updateRouteDisplay(currentRecords);
        document.getElementById('resetButton').classList.remove('hidden');
    } catch (error) {
        displayError(`Reoptimization Error: ${error.message}`);
        console.error(error);
    } finally {
        hideLoading();
    }
}

function deleteStop(index) {
    // Prevent deletion of the first stop (starting point)
    if (index === 0) {
        displayError('Cannot delete the starting point');
        return;
    }

    currentRecords = currentRecords.filter((_, i) => i !== index);
    
    if (currentRecords.length < 2) {
        displayError('Need at least 2 stops for route optimization');
        resetUI();
        return;
    }

    reoptimizeRoute();
}

async function initialize() {
    try {
        const mapsLoaded = await initializeGoogleMaps();
        if (!mapsLoaded) return;
        
        const csvFileInput = document.getElementById('csvFile');
        const serviceFilter = document.getElementById('serviceFilter');
        const resetButton = document.getElementById('resetButton');
        const addStopButton = document.getElementById('addStop');
        // Add New Stop toggle functionality
        const addStopToggle = document.getElementById('addStopToggle');
        const addStopForm = document.getElementById('addStopForm');
        const toggleIcon = document.getElementById('toggleIcon');
        
        addStopToggle.addEventListener('click', () => {
            addStopForm.classList.toggle('hidden');
            toggleIcon.classList.toggle('rotate-180');
        });
        
        csvFileInput.addEventListener('change', handleFileSelect);
        serviceFilter.addEventListener('change', handleFileSelect);
        resetButton.addEventListener('click', () => {
            csvFileInput.value = '';
            resetUI();
            currentRecords = [];
        });
        addStopButton.addEventListener('click', addNewStop);

        // Event delegation for all buttons in the route list
        document.getElementById('result').addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-stop')) {
                const index = parseInt(e.target.dataset.index);
                if (!isNaN(index)) {
                    deleteStop(index);
                }
            }
        });
    } catch (error) {
        displayError(`Initialization Error: ${error.message}`);
    }
}

window.addEventListener('load', initialize);