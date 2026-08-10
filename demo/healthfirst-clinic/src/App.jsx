import Navbar from './components/Navbar.jsx'
import Hero from './components/Hero.jsx'
import Services from './components/Services.jsx'
import Doctors from './components/Doctors.jsx'
import HealthPackages from './components/HealthPackages.jsx'
import Appointment from './components/Appointment.jsx'
import Testimonials from './components/Testimonials.jsx'
import Contact from './components/Contact.jsx'
import Footer from './components/Footer.jsx'
export default function App() {
  return (
    <div className="min-h-screen bg-white">
      <Navbar />
      <main>
        <Hero />
        <Services />
        <Doctors />
        <HealthPackages />
        <Appointment />
        <Testimonials />
        <Contact />
      </main>
      <Footer />
    </div>
  )
}
