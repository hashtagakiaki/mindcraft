import subprocess
import socketio
import time
import json
import os
import atexit
import threading
import sys
import signal
import stat
from pathlib import Path

class Mindcraft:
    def __init__(self):
        self.sio = socketio.Client()
        self.process = None
        self.connected = False
        self.log_thread = None
        self.session_file = None

    def _log_reader(self):
        for line in iter(self.process.stdout.readline, ''):
            sys.stdout.write(f'[Node.js] {line}')
            sys.stdout.flush()

    def init(self, port=8080, session_file=None):
        if self.process:
            return

        self.port = port
        
        node_script_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'init-mindcraft.js'))
        
        environment = os.environ.copy()
        if session_file is not None:
            self.session_file = Path(session_file).expanduser().resolve()
            environment['MINDCRAFT_SESSION_FILE'] = str(self.session_file)
            environment['MINDCRAFT_MANAGEMENT_AUTH_MODE'] = 'protected'
        self.process = subprocess.Popen([
            'node',
            node_script_path,
            '--mindserver_port', str(self.port)
        ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=environment)
        
        self.log_thread = threading.Thread(target=self._log_reader)
        self.log_thread.daemon = True
        self.log_thread.start()

        atexit.register(self.shutdown)
        time.sleep(2) # Give server time to start before connecting

        try:
            auth = None
            if session_file is not None:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and not self.session_file.is_file():
                    if self.process.poll() is not None:
                        raise RuntimeError('MindServer exited before writing its private session file')
                    time.sleep(0.05)
                if stat.S_IMODE(self.session_file.stat().st_mode) != 0o600:
                    raise RuntimeError('MindServer private session file must have mode 0600')
                document = json.loads(self.session_file.read_text(encoding='utf-8'))
                token = document.get('operator')
                if not isinstance(token, str) or len(token) != 64:
                    raise RuntimeError('MindServer private operator session is malformed')
                auth = {'token': token}
            self.sio.connect(f'http://localhost:{self.port}', auth=auth)
            self.connected = True
            print("Connected to MindServer. Mindcraft is initialized.")
        except Exception as e:
            print(f"Failed to connect to MindServer: {e}")
            self.shutdown()
            raise

    def create_agent(self, settings_json):
        if not self.connected:
            raise Exception("Not connected to MindServer. Call init() first.")
        
        profile_data = settings_json.get('profile', {})
        
        def callback(response):
            if response.get('success'):
                print(f"Agent '{profile_data.get('name')}' created successfully")
            else:
                print(f"Error creating agent: {response.get('error', 'Unknown error')}")

        self.sio.emit('create-agent', settings_json, callback=callback)

    def shutdown(self):
        shutdown_requested = False
        if self.connected and self.session_file is not None:
            try:
                self.sio.call('shutdown', timeout=5)
                shutdown_requested = True
            except Exception:
                pass
        if self.sio.connected:
            self.sio.disconnect()
            self.connected = False
        if self.process:
            if not shutdown_requested:
                self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            self.process = None
        print("Mindcraft shut down.")

    def wait(self):
        """Block the main thread until Ctrl+C is pressed so the server stays up,"""
        print("Server is running. Press Ctrl+C to exit.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nCtrl+C detected. Exiting...")
            self.shutdown()

mindcraft_instance = Mindcraft()

def init(port=8080, session_file=None):
    mindcraft_instance.init(port, session_file)

def create_agent(settings_json):
    mindcraft_instance.create_agent(settings_json)
    
def shutdown():
    mindcraft_instance.shutdown()

def wait():
    mindcraft_instance.wait()
