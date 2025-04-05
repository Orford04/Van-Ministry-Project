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

// Help modal functionality
document.getElementById('helpButton').addEventListener('click', function() {
    document.getElementById('helpModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // Prevent scrolling behind modal
});

document.getElementById('closeHelpModal').addEventListener('click', function() {
    document.getElementById('helpModal').classList.add('hidden');
    document.body.style.overflow = 'auto'; // Restore scrolling
});

// Close modal if clicking outside the content
document.getElementById('helpModal').addEventListener('click', function(e) {
    if (e.target === this) {
        this.classList.add('hidden');
        document.body.style.overflow = 'auto';
    }
});

function parseCSV(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const csv = event.target.result;
                const lines = csv.split('\n');
                const headers = lines[0].split(',').map(h => h.trim());

                // Log the first few lines to better understand the format
                console.log("CSV Headers:", headers);
                if (lines.length > 1) console.log("First record:", lines[1]);
                if (lines.length > 2) console.log("Second record:", lines[2]);
                
                // Map exact column names from the CSV
                const columnIndices = {
                    firstName: headers.indexOf('First Name'),
                    lastName: headers.indexOf('Last Name'),
                    street: headers.indexOf('Home Address Street'),
                    city: headers.indexOf('Home Address City'),
                    state: headers.indexOf('Home Address State'),
                    zip: headers.indexOf('Home Address Zip'),
                    service: headers.indexOf('Which service do you need a ride to?'),
                    physicalNeeds: headers.indexOf('Please list any physical needs that would affect transportation. If you don\'t have any, type NONE.'),
                    mobilePhone: headers.indexOf('Mobile Phone Number'),
                    homePhone: headers.indexOf('Home Phone Number'),
                    workPhone: headers.indexOf('Work Phone Number'),
                    selection: headers.indexOf('Selection'),
                    status: headers.indexOf('Status')
                };

                // Verify required columns exist
                const requiredColumns = ['street', 'city', 'state', 'zip']; /*remove selection*/
                const missingColumns = requiredColumns.filter(col => 
                    columnIndices[col] === -1
                );

                if (missingColumns.length > 0) {
                    throw new Error(`Missing required columns: ${missingColumns.join(', ')}`);
                }

                console.log("Found column indices:", columnIndices);

                // Count total and driver/assistant records for debugging
                let totalRecords = 0;
                let driverAssistantRecords = 0;

                const allRecords = lines.slice(1)
                    .filter(line => line.trim()) // Skip empty lines
                    .map((line, index) => {
                      totalRecords++;
                        
                        // Split the line, handling possible commas within quoted fields
                        const values = line.split(',').map(v => v.trim());

                        // Check both selection field and for keywords
                        const selection = values[columnIndices.selection] || '';
                        const status = values[columnIndices.status] || '';
                        const isDriverAssistant = 
                            (selection.toLowerCase().includes('driver') || 
                            selection.toLowerCase().includes('assistant') ||
                            selection === 'Driver / Assistant' ||
                            selection.toLowerCase().includes('driver / assistant') ||
                            selection.toLowerCase().includes('driver/assistant') ||
                            status.toLowerCase().includes('driver') ||
                            status.toLowerCase().includes('assistant'));

                        // Log driver/assistant detection for debugging
                        if (isDriverAssistant) {
                            console.log(`Detected Driver/Assistant: ${values[columnIndices.firstName] || ''} ${values[columnIndices.lastName] || ''} - Selection: "${selection}", Status: "${status}"`);
                            driverAssistantRecords++;
                            return null;
                        }
                        
                        // Combine all available phone numbers
                        const phoneNumbers = [
                            values[columnIndices.mobilePhone],
                            values[columnIndices.homePhone],
                            values[columnIndices.workPhone]
                        ]
                            .filter(phone => phone && phone.trim())
                            .join(' / ');
                        /*
                        // Combine medical notes and transportation needs
                        const combinedNotes = [
                            values[columnIndices.medicalNotes],
                            values[columnIndices.notes]
                        ]
                            .filter(note => note && note.trim() && note.toLowerCase() !== 'none')
                            .join(' | ');

                        // Try to get the rider count from the selection field
                        let riderCount = 1;
                        if (selection && selection.includes("How many people need a ride from your home?")) {
                            const match = selection.match(/\((\d+)\)/);
                            if (match && match[1]) {
                                riderCount = parseInt(match[1]);
                            }
                        }*/

                        const record = {
                            name: `${values[columnIndices.firstName] || ''} ${values[columnIndices.lastName] || ''}`.trim(),
                            street: values[columnIndices.street],
                            city: values[columnIndices.city],
                            state: values[columnIndices.state],
                            zip: values[columnIndices.zip],
                            service: values[columnIndices.service] || '',
                            phone: phoneNumbers || 'No phone number provided',
                            notes: values[columnIndices.physicalNeeds] || 'None',
                            riderCount: 1
                            /*selection: selection*/
                        };

                        // Add full address property
                        record.fullAddress = `${record.street}, ${record.city}, ${record.state} ${record.zip}`;

                        return record;
                    })
                    .filter(record => {
                        // Filter out null records and those missing required address fields
                        const isValid = record && 
                                        record.street && 
                                        record.city && 
                                        record.state && 
                                        record.zip;
                                        // record.selection !== 'Driver / Assistant';

                        if (!isValid && record) {
                            console.log("Filtered out invalid record:", record);
                        }
                        return isValid;
                    });

                // Combine duplicate addresses, keeping the first person's name and merging other details
                const combinedRecords = allRecords.reduce((acc, record) => {
                    const existingRecord = acc.find(r =>
                        normalizeAddress(r.fullAddress) === normalizeAddress(record.fullAddress)
                    );

                    if (existingRecord) {
                        // Increment rider count
                        existingRecord.riderCount += 1;

                        // Merge phone numbers
                        const phoneSet = new Set(
                            existingRecord.phone.split(' / ')
                                .concat(record.phone.split(' / '))
                        );
                        existingRecord.phone = Array.from(phoneSet).join(' / ');

                        // Merge notes, removing duplicates and None
                        const notesSet = new Set(
                            existingRecord.notes.split(' | ')
                                .concat(record.notes.split(' | '))
                                .filter(note =>
                                    note &&
                                    note.toLowerCase() !== 'none'   
                                )
                        );
                        existingRecord.notes = Array.from(notesSet).length > 0
                            ? Array.from(notesSet).join(' | ')
                            : 'None';
                        
                        // Combine services, removing duplicates
                        const serviceSet = new Set(
                            (existingRecord.service + ' ' + record.service)
                                .split(/\s+/)
                                .filter(s => s)
                        );
                        existingRecord.service = Array.from(serviceSet).join(', ');
                    } else {
                        acc.push(record);
                    }

                    return acc;
                }, []);

                console.log(`CSV Processing Summary:
                    Total records: ${totalRecords}
                    Driver/Assistant records: ${driverAssistantRecords}
                    Combined rider records: ${combinedRecords.length}
                `);

                resolve(combinedRecords);
            } catch (error) {
                console.error("Error parsing CSV:", error);
                reject(error);
            }
        };
        reader.onerror = (error) => {
            console.error("Error reading file:", error);
            reject(error);
        };
        reader.readAsText(file);
    });
}

// Function to display error with dismissal option
function displayError(message) {
    console.error(message);
    const errorDiv = document.getElementById('error-messages');
    
    // Create a unique ID for this error message
    const errorId = 'error-' + Date.now();
    
    // Create the error message with dismiss button
    const errorElement = document.createElement('div');
    errorElement.id = errorId;
    errorElement.className = 'bg-red-50 border-l-4 border-red-500 p-4 mb-4 relative';
    errorElement.innerHTML = `
        <div class="flex">
            <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
                </svg>
            </div>
            <div class="ml-3">
                <p class="text-sm text-red-700">${message}</p>
            </div>
        </div>
        <button class="absolute top-1 right-1 text-red-400 hover:text-red-600" onclick="document.getElementById('${errorId}').remove();">
            <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
        </button>
    `;
    
    errorDiv.appendChild(errorElement);
}

// Function to clear all errors
function clearErrors() {
    document.getElementById('error-messages').innerHTML = '';
}

// Function to validate addresses using Google Maps Geocoding API
async function validateAddresses(records) {
    const geocoder = new google.maps.Geocoder();
    const validatedRecords = [];
    const invalidRecords = [];
    
    showLoading();
    
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        try {
            // Use a promise to wait for geocoding results
            const result = await new Promise((resolve, reject) => {
                geocoder.geocode({ 'address': record.fullAddress }, function(results, status) {
                    if (status === google.maps.GeocoderStatus.OK) {
                        resolve(results);
                    } else {
                        reject(new Error(status));
                    }
                });
            });
            
            // If we get here, the address is valid
            // Update the record with the formatted address from Google
            const validatedRecord = {...record};
            validatedRecord.formattedAddress = result[0].formatted_address;
            validatedRecord.geocoded = true;
            validatedRecord.location = {
                lat: result[0].geometry.location.lat(),
                lng: result[0].geometry.location.lng()
            };
            
            validatedRecords.push(validatedRecord);
            
            // Update progress every 5 records
            if (i % 5 === 0) {
                displayProgress(`Validating addresses... (${i+1}/${records.length})`);
            }
            
            // Add a small delay to avoid hitting rate limits
            await sleep(100);
            
        } catch (error) {
            console.warn(`Failed to validate address for ${record.name}: ${record.fullAddress}`, error);
            record.geocoded = false;
            record.validationError = error.message;
            invalidRecords.push(record);
        }
    }
    
    hideLoading();
    
    // Display a warning if there are invalid addresses
    if (invalidRecords.length > 0) {
        const errorId = 'invalid-addresses-' + Date.now();
        const errorMsg = `
            <div id="${errorId}" class="bg-yellow-50 border-l-4 border-yellow-500 p-4 mb-4 relative">
                <div class="flex">
                    <div class="flex-shrink-0">
                        <svg class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                        </svg>
                    </div>
                    <div class="ml-3">
                        <p class="text-sm text-yellow-700 font-medium">Found ${invalidRecords.length} invalid or unresolvable addresses:</p>
                        <ul class="text-sm ml-4 mt-2 list-disc text-yellow-700">
                            ${invalidRecords.map(r => `<li>${r.name}: ${r.fullAddress} (${r.validationError})</li>`).join('')}
                        </ul>
                        <div class="mt-3">
                            <button id="proceedWithValid" class="px-3 py-1 bg-blue-500 text-white rounded mr-2 hover:bg-blue-600">
                                Proceed with valid addresses only
                            </button>
                            <button id="cancelRoute" class="px-3 py-1 bg-gray-300 text-gray-700 rounded hover:bg-gray-400">
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
                <button class="absolute top-1 right-1 text-yellow-400 hover:text-yellow-600" 
                        onclick="document.getElementById('${errorId}').remove();">
                    <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                </button>
            </div>
        `;
        
        const errorDiv = document.getElementById('error-messages');
        errorDiv.innerHTML = errorMsg;
        
        // Return a promise that resolves when the user makes a choice
        return new Promise((resolve, reject) => {
            document.getElementById('proceedWithValid').addEventListener('click', () => {
                document.getElementById(errorId).remove();
                resolve(validatedRecords);
            });
            
            document.getElementById('cancelRoute').addEventListener('click', () => {
                document.getElementById(errorId).remove();
                resetUI();
                reject(new Error('Address validation cancelled'));
            });
        });
    }
    
    return validatedRecords;
}

function normalizeAddress(address) {
    address = address.toLowerCase();
    address = address.replace(/\s+/g, ' ').trim();

    // Remove common abbreviations
    const abbreviations = {
        'street': 'st',
        'avenue': 'ave',
        'road': 'rd',
        'boulevard': 'blvd',
        'drive': 'dr',
        'court': 'ct',
        'lane': 'ln',
        'place': 'pl'
    };

    Object.entries(abbreviations).forEach(([full, abbr]) => {
        address = address.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
    });

    // Remove punctuation except commas and periods
    address = address.replace(/[^\w\s,.-]/g, '');

    // Remove directional prefixes/suffixes
    const directionals = ['n', 'north', 's', 'south', 'e', 'east', 'w', 'west'];
    directionals.forEach(dir => {
        address = address.replace(new RegExp(`\\b${dir}\\b`, 'g'), '');
    });

    return address
}

// Function to display progress updates
function displayProgress(message) {
    const loadingDiv = document.getElementById('loading');
    loadingDiv.innerHTML = `
        <div class="flex items-center justify-center mb-4">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            <span class="ml-2 text-gray-600">${message}</span>
        </div>
    `;
    loadingDiv.classList.remove('hidden');
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
    console.log('Original records length: ${records.length}, route length: ${route.length}');
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
    console.log("Addresses for route:", addresses);
    console.log("Number of addresses:", addresses.length);

    if (addresses.length > 27) { //25 waypoints + origin + destination
        displayError(`Route has ${addresses.length - 2} stops, exceeding Google Maps limit of 25 waypoints. The route will be displayed without optimization.`);
    }

    // Limit waypoints to 25 (Google Maps API limit)
    const MAX_WAYPOINTS = 25;
    let waypoints = addresses.slice(1, -1).map(address => ({
        location: address,
        stopover: true
    }));

    // If too many waypoints, let the user know some will be excluded from the map
    // but we'll keep them in the route list
    if (waypoints.length > MAX_WAYPOINTS) {
        displayError(`Only showing first ${MAX_WAYPOINTS} stops on the map due to Google Maps limitations, but all stops are included in the route list.`);
        waypoints = waypoints.slice(0, MAX_WAYPOINTS);
    }

    return new Promise((resolve, reject) => {
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
    // Google Maps has a limit of 10 waypoints in the URL
    const MAX_URL_WAYPOINTS = 10;

    const origin = encodeURIComponent(route[0].fullAddress);
    const destination = encodeURIComponent(route[0].fullAddress); // Return to start
    
    // Take only the first 10 waypoints for the URL
    const waypointsToInclude = route.slice(1, Math.min(route.length - 1, MAX_URL_WAYPOINTS + 1));
    
    // Convert intermediate stops to waypoints
    const waypoints = waypointsToInclude
        .map(stop => encodeURIComponent(stop.fullAddress))
        .join('|');

    // Alert the user if we've truncated waypoints
    if (route.length - 2 > MAX_URL_WAYPOINTS) {
        displayError(`Google Maps URLs can only include ${MAX_URL_WAYPOINTS} stops (besides start/end) will be included in the Google Maps link. You may need to create multiple routes.`);
    }
    
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
    const resetButton = document.getElementById('resetButton');
    
    resultDiv.classList.remove('hidden');
    resultDiv.className = 'mt-6 bg-white p-6 rounded-lg shadow';

    resetButton.classList.remove('hidden');
    
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
                         
        // Initialize rider count if not set
        if (record.riderCount === undefined) {
            record.riderCount = isStartPoint ? 0 : 1;
        }
        
        // For the start point: allow count to go to 0
        // For other points: minimum is 1
        const minRiderCount = isStartPoint ? 0 : 1;
        const disableDecrement = record.riderCount <= minRiderCount;
        
        const riderText = record.riderCount === 1 ? 'rider' : 'riders';

        li.innerHTML = `
            ${dragHandle}
            <div class="font-semibold text-gray-800 ml-6 flex items-center">
                ${record.name} 
                <span class="text-sm font-normal text-gray-600 ml-2">- ${pointLabel}</span>
                <div class="ml-4 flex items-center">
                    <button class="decrement-riders px-2 py-1 bg-gray-200 rounded-1 text-gray-700 hover:bg-gray-300"
                            data-index="${index}"
                          ${disableDecrement ? 'disabled' : ''}>
                        -
                    </button>
                    <span class="px-3 py-1 bg-gray-100 riders-count">${record.riderCount} ${riderText}</span>
                    <button class="increment-riders px-2 py-1 bg-gray-200 rounded-r text-gray-700 hover:bg-gray-300"
                            data-index="${index}">
                        +
                    </button>
                </div>
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

    document.querySelectorAll('.increment-riders').forEach(button => {
        button.addEventListener('click', function() {
            const index = parseInt(this.getAttribute('data-index'), 10);
            adjustRiderCount(index, 1);
        });
    });

    document.querySelectorAll('.decrement-riders').forEach(button => {
        button.addEventListener('click', function() {
            const index = parseInt(this.getAttribute('data-index'), 10);
            adjustRiderCount(index, -1);
        });
    });

    // Add event listeners to all delete buttons AFTER adding them to the DOM
    document.querySelectorAll('.delete-stop').forEach(button => {
        button.removeEventListener('click', deleteButtonHandler); // Remove any existing handlers
        button.addEventListener('click', deleteButtonHandler);
    });

    enableDragAndDrop(routeList);

    document.getElementById('getDirections').addEventListener('click', () => {
        const directionsUrl = createGoogleMapsDirectionsUrl(currentRecords);
        window.open(directionsUrl, '_blank');
    });
}

// Add this function to handle delete button clicks
function deleteButtonHandler(event) {
    const index = parseInt(this.getAttribute('data-index'), 10);
    console.log("Delete button clicked for index:", index);
    deleteStop(index);
    event.stopPropagation(); // Prevent event bubbling
}

function adjustRiderCount(index, delta) {
    const record = currentRecords[index];
    const isStartPoint = index === 0;
    
    // Set minimum rider count based on whether it's the start point
    const minRiderCount = isStartPoint ? 0 : 1;
    
    // Ensure rider count doesn't go below minimum
    record.riderCount = Math.max(minRiderCount, (record.riderCount || minRiderCount) + delta);

    // Re-render the route list to update UI
    displayRouteList(currentRecords);
}

// Also update the summary display to maintain consistent styling
function displaySummary(records) {
    const summary = document.getElementById('summary');
    const content = document.getElementById('summaryContent');
    
    summary.classList.remove('hidden');
    summary.className = 'mt-6 bg-white p-6 rounded-lg shadow';
    
    const totalRiders = records.reduce((sum, record) => sum + (record.riderCount || 1), 0);
    const serviceTypes = [...new Set(records.map(r => r.service))];
    
    content.innerHTML = `
        <div class="bg-gray-50 p-4 rounded-lg border border-gray-200">
            <p class="mb-2 text-gray-800"><strong>Total Riders:</strong> ${totalRiders}</p>
            <p class="text-gray-800"><strong>Number of Stops:</strong> ${records.length}</p>
            <p class="text-gray-800"><strong>Services:</strong> ${serviceTypes.join(', ')}</p>
            <p class="text-gray-800 mt-2"><em>Note: Drivers and assistants are not included in the route.</em></p>
        </div>
    `;
}

// Global variable to store original records
let originalRecords = null;
let currentRecords = null;

// Service Time Filter Implementation
function filterRecordsByService(records, selectedService) {
    console.log("Starting service filter with:", { selectedService, totalRecords: records.length });
    
    // If no service is selected or "all" is selected
    if (!selectedService || selectedService === "all") {
        console.log("Using 'All Services' filter");
        return records;
    }
    
    // Log the actual service values we're working with
    console.log("Service values in records:", 
        records.map(r => r["Which service do you need a ride to?"] || r.service).filter(Boolean));
    
    // Filter records based on service field
    const filteredRecords = records.filter(record => {
        // Get service field from either column name or the 'service' property
        const serviceField = record["Which service do you need a ride to?"] || record.service || "";
        
        console.log(`Checking record ${record.name} with service: ${serviceField}`);
        
        // If service field is missing, exclude the record
        if (!serviceField) {
            console.log(`Record missing service field: ${record.name}`);
            return false;
        }
        
        // Case-insensitive comparison
        const normalizedService = serviceField.toLowerCase();
        const normalizedFilter = selectedService.toLowerCase();
        
        // For Sunday filter - match anything containing "sunday"
        if (normalizedFilter.includes("sunday")) {
            if (normalizedService.includes("sunday")) {
                console.log(`Match found for Sunday: ${record.name}`);
                return true;
            }
        }
        
        // For Wednesday filter - match anything containing "wednesday"
        if (normalizedFilter.includes("wednesday")) {
            if (normalizedService.includes("wednesday")) {
                console.log(`Match found for Wednesday: ${record.name}`);
                return true;
            }
        }
        
        // If no match was found
        console.log(`No match for ${record.name} with service: ${serviceField}`);
        return false;
    });
    
    console.log(`Filter results: ${filteredRecords.length} of ${records.length} records matched`);
    
    // If no records match, return all records rather than an empty array
    if (filteredRecords.length === 0) {
        console.warn("No records matched the service filter. Returning all records instead.");
        return records;
    }
    
    return filteredRecords;
}

  function handleFileSelect(event) {
    debugServiceFilter();
    resetUI();
    showLoading();

    // Check if this is a service filter change rather than a file selection
    if (event.target.id === 'serviceFilter') {
        const serviceFilter = event.target.value;
        applyServiceFilter(serviceFilter);
        return;
    }

    const fileInput = event.target;
    console.log("File input element:", fileInput);
    
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        hideLoading();
        displayError('No file selected');
        return;
    }
    
    const file = fileInput.files[0];

    parseCSV(file)
        .then(records => {
            console.log("Parsed records:", records);
            console.log("Service values in CSV:", 
                records.map(r => r["Which service do you need a ride to?"]).filter(Boolean));

            // Store the original records before any modifications
            originalRecords = [...records];
            
            // Validate addresses first time
            return validateAddresses(records);
        })
        .then(validatedRecords => {
            // Make sure service information is preserved
            validatedRecords.forEach(record => {
                // Find the matching original record
                const originalRecord = originalRecords.find(r => r.name === record.name);
                if (originalRecord) {
                    record["Which service do you need a ride to?"] = 
                        originalRecord["Which service do you need a ride to?"];
                }
            });
            
            // Store the validated records
            currentRecords = validatedRecords;
            
            // Apply service filter to the validated records
            const serviceFilter = document.getElementById('serviceFilter').value;
            applyServiceFilter(serviceFilter);
        })
        .catch(error => {
            console.error("Error processing file:", error);
            displayError(`Processing Error: ${error.message}`);
            hideLoading();
        });
}

function debugServiceFilter() {
    console.group("Service Filter Debug");
    
    // Log current UI state
    const serviceFilter = document.getElementById('serviceFilter');
    console.log("Service filter DOM element:", serviceFilter);
    console.log("Selected service:", serviceFilter ? serviceFilter.value : "Element not found");
    
    // Log data state
    console.log("Original records:", originalRecords);
    console.log("Current records:", currentRecords);
    
    // Service values in data
    if (originalRecords) {
        console.log("Service values in original records:", 
            originalRecords.map(r => ({ 
                name: r.name, 
                service: r["Which service do you need a ride to?"] 
            })));
    }
    
    console.groupEnd();
}

// Add event listener for service filter changes
function setupServiceFilterListener() {
    const serviceFilterSelect = document.getElementById('serviceFilter');
    if (serviceFilterSelect) {
        serviceFilterSelect.addEventListener('change', function() {
            const selectedService = this.value;
            console.log("Service filter changed to:", selectedService);
            showLoading();
            applyServiceFilter(selectedService);
        });
    } else {
        console.error("Service filter element not found in the DOM");
    }
}

// Apply service filtering without revalidation
function applyServiceFilter(serviceFilter) {
    debugServiceFilter();
    // Ensure we have original records
    if (!originalRecords || originalRecords.length === 0) {
        displayError('No records available to filter');
        hideLoading();
        return;
    }

    console.log("Applying service filter:", serviceFilter);
    
    try {
        // If we don't have validated records yet, validate them first
        if (!currentRecords || currentRecords.length === 0) {
            // First time validation
            validateAddresses([...originalRecords])
                .then(validatedRecords => {
                    // Store all validated records
                    const allValidatedRecords = validatedRecords;
                    
                    // Now apply the service filter to these validated records
                    const filteredRecords = filterRecordsByService([...allValidatedRecords], serviceFilter);
                    
                    if (filteredRecords.length < 2) {
                        displayError('Not enough addresses to optimize route after filtering');
                        hideLoading();
                        return;
                    }
                    
                    // Update current records with filtered results
                    currentRecords = filteredRecords;
                    displayRouteList(currentRecords);
                    hideLoading();
                })
                .catch(error => {
                    console.error("Error validating addresses:", error);
                    displayError(`Validation Error: ${error.message}`);
                    hideLoading();
                });
        } else {
            // We need to filter from the original validated records
            // First, copy the validated records that have geocoding information
            const geocodedRecords = currentRecords.filter(record => record.geocoded === true);
            
            // Next, create a lookup of validated addresses
            const validatedAddressMap = new Map();
            geocodedRecords.forEach(record => {
                // Use a combination of name and address as the key to ensure uniqueness
                const key = `${record.name}-${record.fullAddress}`;
                validatedAddressMap.set(key, record);
            });
            
            // Now apply the service filter to the original records but keep geocoding info
            const recordsToFilter = originalRecords.map(origRecord => {
                const key = `${origRecord.name}-${origRecord.fullAddress}`;
                // If we have a validated version, use that
                if (validatedAddressMap.has(key)) {
                    return validatedAddressMap.get(key);
                }
                // Otherwise use the original record
                return origRecord;
            });
            
            // Now apply the service filter
            const filteredRecords = filterRecordsByService(recordsToFilter, serviceFilter);
            
            console.log(`Filtered records: ${filteredRecords.length}`);
            
            if (filteredRecords.length < 2) {
                displayError('Not enough addresses to optimize route after filtering');
                hideLoading();
                return;
            }
            
            // Update current records and display
            currentRecords = filteredRecords;
            displayRouteList(currentRecords);
            hideLoading();
        }
    } catch (error) {
        console.error("Error in service filter application:", error);
        displayError(`Filter Error: ${error.message}`);
        hideLoading();
    }
}

function addNewStop() {
    const name = document.getElementById('newName').value.trim();
    const phone = document.getElementById('newPhone').value.trim();
    const street = document.getElementById('newStreet').value.trim();
    const city = document.getElementById('newCity').value.trim();
    const state = document.getElementById('newState').value.trim();
    const zip = document.getElementById('newZip').value.trim();
    const notes = document.getElementById('newNotes').value.trim();
    const role = document.getElementById('newRole').value.trim();
    
    if (!name || !street || !city || !state || !zip) {
        displayError('Name, street address, city, state, and zip code are required');
        return;
    }

    // Don't add the stop if it's a driver/assistant
    if (role === 'driver' || role === 'assistant') {
        displayError('Drivers and assistants are not added to the route');
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
        riderCount: 1,
        selection: 'How many people need a ride from your home? (1)', //Set as rider by default
        service: document.getElementById('serviceFilter').value
    };

    currentRecords.push(newStop);
    displayRouteList(currentRecords);
    
    // Clear input fields
    document.getElementById('newName').value = '';
    document.getElementById('newPhone').value = '';
    document.getElementById('newStreet').value = '';
    document.getElementById('newCity').value = '';
    document.getElementById('newState').value = '';
    document.getElementById('newZip').value = '';
    document.getElementById('newNotes').value = '';
}

async function optimizeRoute() {
    if (!currentRecords || currentRecords.length < 2) {
        displayError('Need at least 2 stops for route optimization');
        return;
    }

    showLoading();
    clearErrors();
    
    try {
        const addresses = currentRecords.map(record => record.fullAddress);
        const service = new google.maps.DistanceMatrixService();
        const matrix = await getDistanceMatrixWithRetry(service, addresses);
        const route = nearestNeighbor(matrix, currentRecords);
        currentRecords = route; // Update currentRecords with the optimized route
        
        const map = new google.maps.Map(document.getElementById("map"), {
            zoom: 12,
            center: { lat: 38.8817, lng: -94.8191 },
        })

        const directionsService = new google.maps.DirectionsService();
        const directionsRenderer = new google.maps.DirectionsRenderer();
        directionsRenderer.setMap(map);

        await displayMapRoute(directionsService, directionsRenderer, route.map(r => r.formattedAddress || r.fullAddress));
        displayRouteList(route);
        document.getElementById('resetButton').classList.remove('hidden');
    } catch (error) {
        displayError(`Optimization Error: ${error.message}`);
        console.error(error);
    } finally {
        hideLoading();
    }
}

function deleteStop(index) {
    console.log("Deleting stop at index:", index);
    console.log("Before deletion:", currentRecords.length, "records");
    
    // Prevent deletion of the first stop (starting point)
    if (index === 0) {
        displayError('Cannot delete the starting point');
        return;
    }
    
    // Create a new array without the item at the specified index
    const newRecords = [];
    for (let i = 0; i < currentRecords.length; i++) {
        if (i !== index) {
            newRecords.push(currentRecords[i]);
        }
    }
    
    // Update currentRecords with the new array
    currentRecords = newRecords;
    
    console.log("After deletion:", currentRecords.length, "records");
    
    if (currentRecords.length < 2) {
        displayError('Need at least 2 stops for route optimization');
        resetUI();
        return;
    }
    
    // Update the display with the modified records
    displayRouteList(currentRecords);
}

async function initialize() {
    try {
        const mapsLoaded = await initializeGoogleMaps();
        if (!mapsLoaded) return;
        
        // Get DOM elements
        const csvFileInput = document.getElementById('csvFile');
        const serviceFilter = document.getElementById('serviceFilter');
        const resetButton = document.getElementById('resetButton');
        const addStopButton = document.getElementById('addStop');
        const addStopToggle = document.getElementById('addStopToggle');
        const addStopForm = document.getElementById('addStopForm');
        const toggleIcon = document.getElementById('toggleIcon');
        const optimizeRouteButton = document.getElementById('optimizeRoute');

        // Add event listeners for file and service selection
        csvFileInput.addEventListener('change', handleFileSelect);

        // Reset button functionality
        resetButton.addEventListener('click', async () => {
            // Show loading indicator
            showLoading();
            clearErrors();
            
            try {
                // Revert to the original records before any edits
                if (originalRecords) {
                    // Re-validate addresses like when first uploaded
                    const validatedRecords = await validateAddresses([...originalRecords]);
                    
                    // Update current records with validated ones
                    currentRecords = validatedRecords;
                    
                    // Update UI
                    displaySummary(currentRecords);
                    displayRouteList(currentRecords);
                    
                    // Clear the map and prepare for fresh display
                    const map = new google.maps.Map(document.getElementById("map"), {
                        zoom: 12,
                        center: { lat: 38.8817, lng: -94.8191 },
                    });
                    
                    document.getElementById('map').classList.remove('hidden');
                    
                    // Create new directions service and renderer
                    const directionsService = new google.maps.DirectionsService();
                    const directionsRenderer = new google.maps.DirectionsRenderer({
                        map: map,
                        suppressMarkers: false,
                        draggable: false
                    });
                    
                    // Get addresses in the current order
                    const addresses = currentRecords.map(r => r.fullAddress);
                    
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
                    directionsRenderer.setDirections(result);
                }
            } catch (error) {
                displayError(`Reset Error: ${error.message}`);
                console.error(error);
            } finally {
                hideLoading();
            }
        });

        // Add new stop functionality
        addStopButton.addEventListener('click', addNewStop);

        // Optimize route button functionality
        optimizeRouteButton.addEventListener('click', optimizeRoute);
        
        // Toggle form visibility
        addStopToggle.addEventListener('click', () => {
            addStopForm.classList.toggle('hidden');
            toggleIcon.classList.toggle('rotate-180');
        });

        // Event delegation for route list buttons (e.g., delete stops)
        document.getElementById('result').addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-stop')) {
                const index = parseInt(e.target.dataset.index);
                if (!isNaN(index)) {
                    deleteStop(index);
                }
            }
        });

        document.getElementById('serviceFilter').addEventListener('change', function() {
            showLoading();
            const serviceFilter = this.value;
            applyServiceFilter(serviceFilter);
        });

        document.addEventListener('DOMContentLoaded', function() {
            setupServiceFilterListener();
        });

    } catch (error) {
        displayError(`Initialization Error: ${error.message}`);
    }
}

// Initialize the app when the window loads
window.addEventListener('load', initialize);