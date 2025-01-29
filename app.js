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

function displayRouteList(route) {
    const resultDiv = document.getElementById('result');
    const routeList = document.getElementById('routeList');
   
    resultDiv.classList.remove('hidden');
    routeList.innerHTML = '';
   
    route.forEach((record, index) => {
        const li = document.createElement('li');
        li.className = 'mb-4 p-3 bg-gray-50 rounded';
        li.innerHTML = `
            <div class="font-semibold">${index + 1}. ${record.name}</div>
            <div>${record.fullAddress}</div>
            <div class="text-sm text-gray-600">Phone: ${record.phone}</div>
            <div class="text-sm text-gray-600">Notes: ${record.notes}</div>
            <button class="delete-stop absolute top-2 right-2 px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm" 
                    data-index="${index}">
                Delete
            </button>
        `;
        routeList.appendChild(li);
    });
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

async function initialize() {
    try {
        const mapsLoaded = await initializeGoogleMaps();
        if (!mapsLoaded) return;
        
        const csvFileInput = document.getElementById('csvFile');
        const serviceFilter = document.getElementById('serviceFilter');
        const resetButton = document.getElementById('resetButton');
        const addStopButton = document.getElementById('addStop');
        
        csvFileInput.addEventListener('change', handleFileSelect);
        serviceFilter.addEventListener('change', handleFileSelect);
        resetButton.addEventListener('click', () => {
            csvFileInput.value = '';
            resetUI();
        });
        addStopButton.addEventListener('click', addNewStop);

        // Add event delegation for delete buttons
        document.getElementById('routeList').addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-stop')) {
                const index = parseInt(e.target.dataset.index);
                deleteStop(index);
            }
        });
    } catch (error) {
        displayError(`Initialization Error: ${error.message}`);
    }
}

let currentRecords = []; // Store the current records globally

function addNewStop() {
    const name = document.getElementById('newName').value.trim();
    const phone = document.getElementById('newPhone').value.trim();
    const address = document.getElementById('newAddress').value.trim();
    const notes = document.getElementById('newNotes').value.trim();
    
    if (!name || !address) {
        displayError('Name and address are required');
        return;
    }

    const newStop = {
        name: name,
        fullAddress: address,
        phone: phone,
        notes: notes || 'None',
        service: document.getElementById('serviceFilter').value
    };

    currentRecords.push(newStop);
    reoptimizeRoute();
    
    // Clear input fields
    document.getElementById('newName').value = '';
    document.getElementById('newPhone').value = '';
    document.getElementById('newAddress').value = '';
    document.getElementById('newNotes').value = '';
}

function deleteStop(index) {
    currentRecords.splice(index, 1);
    if (currentRecords.length < 2) {
        displayError('Need at least 2 stops for route optimization');
        return;
    }
    reoptimizeRoute();
}

async function reoptimizeRoute() {
    showLoading();
    try {
        const addresses = currentRecords.map(record => record.fullAddress);
        const service = new google.maps.DistanceMatrixService();
        
        const matrix = await getDistanceMatrixWithRetry(service, addresses);
        const route = nearestNeighbor(matrix, currentRecords);
        
        const directionsService = new google.maps.DirectionsService();
        const directionsRenderer = new google.maps.DirectionsRenderer();
        const map = new google.maps.Map(document.getElementById("map"), {
            zoom: 12,
            center: { lat: 38.8817, lng: -94.8191 },
        });
        directionsRenderer.setMap(map);
        
        displaySummary(currentRecords);
        await displayMapRoute(directionsService, directionsRenderer, route.map(r => r.fullAddress));
        displayRouteList(route);
    } catch (error) {
        displayError(`Reoptimization Error: ${error.message}`);
    } finally {
        hideLoading();
    }
}

window.addEventListener('load', initialize);