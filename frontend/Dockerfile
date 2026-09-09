FROM nginx:alpine

# Static files only — no build step, no framework. nginx serves them as-is.
COPY index.html style.css sse.js socket.js publish.js app.js /usr/share/nginx/html/

EXPOSE 80
