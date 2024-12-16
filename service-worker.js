// service-worker.js
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
  
    if (url.pathname === '/index.html') {
      event.respondWith(
        fetch(event.request).then(response => {
          const clonedResponse = response.clone();
          const reader = clonedResponse.body.getReader();
  
          return new ReadableStream({
            async start(controller) {
              let received = '';
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                received += new TextDecoder('utf-8').decode(value);
  
                // Inject the API key here
                const injectedHtml = received.replace('YOUR_API_KEY', 'YOUR_ACTUAL_API_KEY');
  
                controller.enqueue(new TextEncoder().encode(injectedHtml));
              }
              controller.close();
            }
          });
        })
      );
    } else {
      event.respondWith(fetch(event.request));
    }
  });